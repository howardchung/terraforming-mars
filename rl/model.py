import base64
from datetime import datetime, timezone
import json
import os
from typing import Any, Dict, Optional, Tuple

import numpy as np
import torch
import torch.nn as nn
from torch.distributions import Categorical

STATE_DIM = 1532
HIDDEN_DIM = 256
ACTION_DIM = 605


def _tensor_to_b64_f32(t: torch.Tensor) -> str:
    arr = t.detach().cpu().numpy().astype(np.float32).ravel()
    return base64.b64encode(arr.tobytes()).decode("ascii")


def _b64_f32_to_tensor(b64_str: str, shape: Tuple[int, ...]) -> torch.Tensor:
    raw = base64.b64decode(b64_str.encode("ascii"))
    arr = np.frombuffer(raw, dtype=np.float32).copy().reshape(shape)
    return torch.from_numpy(arr)


def layer_init(layer: nn.Linear, std: float = np.sqrt(2), bias_const: float = 0.0) -> nn.Linear:
    nn.init.orthogonal_(layer.weight, std)
    nn.init.constant_(layer.bias, bias_const)
    return layer


class MaskedActorCriticNet(nn.Module):
    """
    Masked Actor-Critic Neural Network for Terraforming Mars (Tharsis 2P, Base+CE+Prelude).
    Architecture matches src/server/rl/PolicyNetwork.ts bit-for-bit:
      state (1532) -> Linear(256) -> ReLU -> Linear(256) -> ReLU -> Actor(605) & Critic(1)
    """

    def __init__(
        self,
        state_dim: int = STATE_DIM,
        hidden_dim: int = HIDDEN_DIM,
        action_dim: int = ACTION_DIM,
    ) -> None:
        super().__init__()
        self.state_dim = state_dim
        self.hidden_dim = hidden_dim
        self.action_dim = action_dim

        self.fc1 = layer_init(nn.Linear(state_dim, hidden_dim), std=np.sqrt(2))
        self.fc2 = layer_init(nn.Linear(hidden_dim, hidden_dim), std=np.sqrt(2))
        self.actor = layer_init(nn.Linear(hidden_dim, action_dim), std=0.01)
        self.critic = layer_init(nn.Linear(hidden_dim, 1), std=1.0)

    def forward_features(self, state: torch.Tensor) -> torch.Tensor:
        h = torch.relu(self.fc1(state))
        h = torch.relu(self.fc2(h))
        return h

    def forward(self, state: torch.Tensor) -> Tuple[torch.Tensor, torch.Tensor]:
        h = self.forward_features(state)
        logits = self.actor(h)
        value = self.critic(h).squeeze(-1)
        return logits, value

    def get_value(self, state: torch.Tensor) -> torch.Tensor:
        h = self.forward_features(state)
        return self.critic(h).squeeze(-1)

    def get_action_and_value(
        self,
        state: torch.Tensor,
        action_mask: torch.Tensor,
        action: Optional[torch.Tensor] = None,
        deterministic: bool = False,
    ) -> Tuple[torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor]:
        logits, value = self.forward(state)
        # Ensure at least one action is unmasked per row
        valid_mask = action_mask.bool()
        empty_rows = ~valid_mask.any(dim=-1, keepdim=True)
        valid_mask = torch.where(empty_rows, torch.ones_like(valid_mask), valid_mask)

        masked_logits = logits.masked_fill(~valid_mask, -1e9)
        dist = Categorical(logits=masked_logits)

        if action is None:
            if deterministic:
                action = torch.argmax(masked_logits, dim=-1)
            else:
                action = dist.sample()

        log_prob = dist.log_prob(action)
        entropy = dist.entropy()
        return action, log_prob, entropy, value

    def export_weights_dict(self, metadata: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        meta = metadata or {}
        return {
            "version": int(meta.get("version", 1)),
            "step": int(meta.get("step", 0)),
            "episodes": int(meta.get("episodes", 0)),
            "winRate": float(meta.get("winRate", 0.5)),
            "avgVp": float(meta.get("avgVp", 0.0)),
            "updatedAt": datetime.now(timezone.utc).isoformat(),
            "stateDim": self.state_dim,
            "hiddenDim": self.hidden_dim,
            "actionDim": self.action_dim,
            "fc1_weight_b64": _tensor_to_b64_f32(self.fc1.weight),
            "fc1_bias_b64": _tensor_to_b64_f32(self.fc1.bias),
            "fc2_weight_b64": _tensor_to_b64_f32(self.fc2.weight),
            "fc2_bias_b64": _tensor_to_b64_f32(self.fc2.bias),
            "actor_weight_b64": _tensor_to_b64_f32(self.actor.weight),
            "actor_bias_b64": _tensor_to_b64_f32(self.actor.bias),
            "critic_weight_b64": _tensor_to_b64_f32(self.critic.weight),
            "critic_bias_b64": _tensor_to_b64_f32(self.critic.bias),
        }

    def save_portable_weights(self, json_path: str, metadata: Optional[Dict[str, Any]] = None) -> None:
        os.makedirs(os.path.dirname(os.path.abspath(json_path)), exist_ok=True)
        payload = self.export_weights_dict(metadata)
        tmp_path = json_path + ".tmp"
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(payload, f)
        os.replace(tmp_path, json_path)

    def load_portable_weights(self, json_path: str) -> Dict[str, Any]:
        with open(json_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        with torch.no_grad():
            self.fc1.weight.copy_(_b64_f32_to_tensor(data["fc1_weight_b64"], (self.hidden_dim, self.state_dim)))
            self.fc1.bias.copy_(_b64_f32_to_tensor(data["fc1_bias_b64"], (self.hidden_dim,)))
            self.fc2.weight.copy_(_b64_f32_to_tensor(data["fc2_weight_b64"], (self.hidden_dim, self.hidden_dim)))
            self.fc2.bias.copy_(_b64_f32_to_tensor(data["fc2_bias_b64"], (self.hidden_dim,)))
            self.actor.weight.copy_(_b64_f32_to_tensor(data["actor_weight_b64"], (self.action_dim, self.hidden_dim)))
            self.actor.bias.copy_(_b64_f32_to_tensor(data["actor_bias_b64"], (self.action_dim,)))
            self.critic.weight.copy_(_b64_f32_to_tensor(data["critic_weight_b64"], (1, self.hidden_dim)))
            self.critic.bias.copy_(_b64_f32_to_tensor(data["critic_bias_b64"], (1,)))
        return data
