#!/usr/bin/env python3
"""
Masked PPO + Self-Play RL Trainer for Terraforming Mars
Map: Tharsis | Players: 2 | Expansions: Base + Corporate Era + Preludes only
Supports parallel multi-process vectorized environments (num_workers * envs_per_worker).
"""

import argparse
from dataclasses import dataclass
from datetime import datetime, timezone
import json
import os
import sys
import time
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import torch
import torch.nn as nn
import torch.optim as optim

# Ensure repo root is on sys.path
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from rl.env import TerraformingMarsBridge, VectorizedMarsBridge
from rl.model import ACTION_DIM, HIDDEN_DIM, STATE_DIM, MaskedActorCriticNet


@dataclass
class StepRecord:
    state: np.ndarray
    mask: np.ndarray
    action: int
    log_prob: float
    value: float
    reward: float = 0.0
    done: bool = False


@dataclass
class SlotState:
    ep_idx: int
    use_heuristic_opp: bool
    rl_seat: int
    opp_seat: int
    auto_opponent: Optional[str]
    player_names: Tuple[str, str]
    trajectories: Tuple[List[StepRecord], List[StepRecord]]
    obs: Dict[str, Any]


def make_slot_config(ep_idx: int, opponent_arg: str) -> Tuple[bool, int, int, Optional[str], Tuple[str, str]]:
    use_heuristic_opp = (
        opponent_arg == "heuristic"
        or (opponent_arg == "mixed" and (ep_idx % 2 == 1))
    )
    rl_seat = ep_idx % 2
    opp_seat = 1 - rl_seat
    auto_opp = "heuristic" if use_heuristic_opp else None
    if use_heuristic_opp:
        p_names = (
            ("RL-Agent (PPO)", "Heuristic-AI")
            if rl_seat == 0
            else ("Heuristic-AI", "RL-Agent (PPO)")
        )
    else:
        p_names = ("RL-SelfPlay-Red", "RL-SelfPlay-Blue")
    return use_heuristic_opp, rl_seat, opp_seat, auto_opp, p_names


def compute_gae_for_episode(
    records: List[StepRecord],
    gamma: float = 0.995,
    gae_lambda: float = 0.95,
) -> Tuple[np.ndarray, np.ndarray]:
    n = len(records)
    advantages = np.zeros(n, dtype=np.float32)
    returns = np.zeros(n, dtype=np.float32)
    last_gae = 0.0
    for t in reversed(range(n)):
        next_non_terminal = 0.0 if (t == n - 1 or records[t].done) else 1.0
        next_value = 0.0 if (t == n - 1 or records[t].done) else records[t + 1].value
        delta = records[t].reward + gamma * next_value * next_non_terminal - records[t].value
        last_gae = delta + gamma * gae_lambda * next_non_terminal * last_gae
        advantages[t] = last_gae
        returns[t] = advantages[t] + records[t].value
    return advantages, returns


def evaluate_policy(
    vec_bridge: VectorizedMarsBridge,
    model: MaskedActorCriticNet,
    device: torch.device,
    opponent_type: str = "heuristic",
    num_games: int = 6,
) -> Dict[str, float]:
    model.eval()
    wins = 0
    ties = 0
    total_vp = 0.0
    total_opp_vp = 0.0
    total_tr = 0.0
    total_gens = 0.0

    # Run evaluation in parallel across available slots (up to num_games at once)
    batch_games = min(vec_bridge.num_envs, num_games)
    games_completed = 0
    games_started = 0

    active_slots: Dict[int, int] = {}  # slot -> game_idx
    reset_reqs = []
    for slot in range(batch_games):
        g = games_started
        games_started += 1
        rl_seat = g % 2
        opp_seat = 1 - rl_seat
        p_names = (
            ("RL-Agent", f"{opponent_type.capitalize()}-AI")
            if rl_seat == 0
            else (f"{opponent_type.capitalize()}-AI", "RL-Agent")
        )
        active_slots[slot] = g
        reset_reqs.append(
            {
                "slot": slot,
                "seed": float((g + 1) * 0.137 % 1.0),
                "playerNames": p_names,
                "autoOpponent": opponent_type,
                "autoOpponentSeat": opp_seat,
            }
        )

    slot_obs = vec_bridge.reset_slots(reset_reqs)

    while active_slots:
        # Handle any slots that finished immediately during reset/auto-opponent
        finished_slots = [s for s in list(active_slots.keys()) if slot_obs[s]["done"]]
        for slot in finished_slots:
            g = active_slots.pop(slot)
            rl_seat = g % 2
            obs = slot_obs[slot]
            info = obs["info"]
            rl_vp = info["p0Vp"] if rl_seat == 0 else info["p1Vp"]
            opp_vp = info["p1Vp"] if rl_seat == 0 else info["p0Vp"]
            rl_tr = info["p0Tr"] if rl_seat == 0 else info["p1Tr"]
            winner = info["winner"]
            if winner == rl_seat:
                wins += 1
            elif winner == -1:
                ties += 1
            total_vp += rl_vp
            total_opp_vp += opp_vp
            total_tr += rl_tr
            total_gens += obs["generation"]
            games_completed += 1

            if games_started < num_games:
                new_g = games_started
                games_started += 1
                new_rl_seat = new_g % 2
                new_opp_seat = 1 - new_rl_seat
                p_names = (
                    ("RL-Agent", f"{opponent_type.capitalize()}-AI")
                    if new_rl_seat == 0
                    else (f"{opponent_type.capitalize()}-AI", "RL-Agent")
                )
                active_slots[slot] = new_g
                new_obs = vec_bridge.reset_slots(
                    [
                        {
                            "slot": slot,
                            "seed": float((new_g + 1) * 0.137 % 1.0),
                            "playerNames": p_names,
                            "autoOpponent": opponent_type,
                            "autoOpponentSeat": new_opp_seat,
                        }
                    ]
                )
                slot_obs[slot] = new_obs[slot]

        stepping_slots = [s for s in active_slots.keys() if not slot_obs[s]["done"]]
        if not stepping_slots:
            continue

        states_np = np.array([slot_obs[s]["state"] for s in stepping_slots], dtype=np.float32)
        masks_np = np.array([slot_obs[s]["mask"] for s in stepping_slots], dtype=bool)
        states_t = torch.from_numpy(states_np).to(device)
        masks_t = torch.from_numpy(masks_np).to(device)
        with torch.no_grad():
            acts_t, _, _, _ = model.get_action_and_value(states_t, masks_t, deterministic=False)
        acts = acts_t.cpu().numpy()

        step_reqs = []
        for idx, slot in enumerate(stepping_slots):
            g = active_slots[slot]
            rl_seat = g % 2
            opp_seat = 1 - rl_seat
            step_reqs.append(
                {
                    "slot": slot,
                    "action": int(acts[idx]),
                    "autoOpponent": opponent_type,
                    "autoOpponentSeat": opp_seat,
                }
            )
        next_obs_map = vec_bridge.step_slots(step_reqs)
        for slot, n_obs in next_obs_map.items():
            slot_obs[slot] = n_obs

    return {
        "win_rate": wins / max(1, num_games),
        "tie_rate": ties / max(1, num_games),
        "avg_vp": total_vp / max(1, num_games),
        "avg_opp_vp": total_opp_vp / max(1, num_games),
        "avg_tr": total_tr / max(1, num_games),
        "avg_generations": total_gens / max(1, num_games),
    }


def run_warmstart_imitation(
    bridge: TerraformingMarsBridge,
    model: MaskedActorCriticNet,
    optimizer: optim.Optimizer,
    device: torch.device,
    num_steps: int = 600,
) -> float:
    if num_steps <= 0:
        return 0.0
    model.train()
    states_list: List[np.ndarray] = []
    masks_list: List[np.ndarray] = []
    actions_list: List[int] = []

    obs = bridge.reset(env_id="env_ws", player_names=("RL-Warmstart-1", "RL-Warmstart-2"))
    for _ in range(num_steps):
        h_act = bridge.heuristic_action("env_ws")
        states_list.append(np.array(obs["state"], dtype=np.float32))
        masks_list.append(np.array(obs["mask"], dtype=bool))
        actions_list.append(h_act)
        obs = bridge.step("env_ws", h_act)
        if obs["done"]:
            obs = bridge.reset(env_id="env_ws", player_names=("RL-Warmstart-1", "RL-Warmstart-2"))

    states_t = torch.tensor(np.array(states_list), dtype=torch.float32, device=device)
    masks_t = torch.tensor(np.array(masks_list), dtype=torch.bool, device=device)
    actions_t = torch.tensor(np.array(actions_list), dtype=torch.long, device=device)

    batch_size = 128
    total_loss = torch.zeros((), device=device)
    updates = 0
    for _epoch in range(4):
        perm = torch.randperm(states_t.size(0), device=device)
        for start in range(0, states_t.size(0), batch_size):
            idx = perm[start : start + batch_size]
            logits, _ = model(states_t[idx])
            masked_logits = logits.masked_fill(~masks_t[idx], -1e9)
            loss = nn.functional.cross_entropy(masked_logits, actions_t[idx])
            optimizer.zero_grad()
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()
            total_loss += loss.detach()
            updates += 1

    return float(total_loss.item()) / max(1, updates)


def save_metrics_json(metrics_path: str, data: Dict[str, Any]) -> None:
    os.makedirs(os.path.dirname(os.path.abspath(metrics_path)), exist_ok=True)
    tmp_path = metrics_path + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp_path, metrics_path)


def resolve_device(requested: str = "auto", force_cpu: bool = False) -> torch.device:
    """
    Resolve the torch device for training.
      - "auto": CUDA if available, otherwise CPU.
      - "cpu", "cuda", "cuda:N", "mps": explicit selection (validated).
    `force_cpu` (legacy --cpu flag) always wins.
    """
    if force_cpu:
        return torch.device("cpu")
    req = (requested or "auto").strip().lower()
    if req == "auto":
        return torch.device("cuda" if torch.cuda.is_available() else "cpu")

    device = torch.device(req)
    if device.type == "cuda":
        if not torch.cuda.is_available():
            hint = (
                "This PyTorch build has no CUDA support; install a CUDA-enabled build"
                if torch.version.cuda is None
                else "Check that an NVIDIA GPU/driver is visible (nvidia-smi, CUDA_VISIBLE_DEVICES)"
            )
            raise RuntimeError(
                f"Requested device '{requested}' but CUDA is not available "
                f"(torch {torch.__version__}). {hint}, or use --device cpu."
            )
        idx = device.index if device.index is not None else 0
        if idx >= torch.cuda.device_count():
            raise RuntimeError(
                f"Requested device '{requested}' but only {torch.cuda.device_count()} CUDA device(s) are visible."
            )
        device = torch.device("cuda", idx)
    elif device.type == "mps":
        mps = getattr(torch.backends, "mps", None)
        if mps is None or not mps.is_available():
            raise RuntimeError(f"Requested device '{requested}' but MPS is not available.")
    elif device.type != "cpu":
        raise RuntimeError(f"Unsupported device '{requested}'. Use auto, cpu, cuda, cuda:N or mps.")
    return device


def configure_device(device: torch.device, allow_tf32: bool = True) -> str:
    """Apply device-specific settings and return a human-readable description."""
    if device.type == "cuda":
        torch.cuda.set_device(device)
        # TF32 speeds up fp32 matmuls on Ampere+ GPUs with negligible impact on PPO training.
        torch.backends.cuda.matmul.allow_tf32 = allow_tf32
        torch.backends.cudnn.allow_tf32 = allow_tf32
        props = torch.cuda.get_device_properties(device)
        return (
            f"{device} ({props.name}, {props.total_memory / (1024 ** 3):.1f} GiB, "
            f"CUDA {torch.version.cuda}, TF32={'on' if allow_tf32 else 'off'})"
        )
    return str(device)


def train(args: argparse.Namespace) -> None:
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)
    torch.cuda.manual_seed_all(args.seed)  # no-op when CUDA is unavailable

    device = resolve_device(args.device, force_cpu=args.cpu)
    print(f"[RL] Using device: {configure_device(device, allow_tf32=not args.no_tf32)}")
    checkpoints_dir = os.path.join(REPO_ROOT, "rl", "checkpoints")
    os.makedirs(checkpoints_dir, exist_ok=True)

    latest_pt = os.path.join(checkpoints_dir, "latest.pt")
    best_pt = os.path.join(checkpoints_dir, "best.pt")
    latest_json = os.path.join(checkpoints_dir, "latest_weights.json")
    best_json = os.path.join(checkpoints_dir, "best_weights.json")
    metrics_path = os.path.join(checkpoints_dir, "training_metrics.json")

    model = MaskedActorCriticNet(STATE_DIM, HIDDEN_DIM, ACTION_DIM).to(device)
    optimizer = optim.Adam(model.parameters(), lr=args.lr, eps=1e-5)

    start_episode = 0
    total_steps = 0
    best_score = -1e9
    history: List[Dict[str, Any]] = []
    eval_random: Dict[str, Any] = {}
    eval_heur: Dict[str, Any] = {}

    if os.path.exists(metrics_path) and not args.fresh:
        try:
            with open(metrics_path, "r", encoding="utf-8") as f:
                prev_metrics = json.load(f)
                history = prev_metrics.get("history", [])
                start_episode = int(prev_metrics.get("episodesCompleted", 0))
                total_steps = int(prev_metrics.get("totalSteps", 0))
                best_score = float(prev_metrics.get("bestScore", -1e9))
                eval_random = prev_metrics.get("evalVsRandom", {}) or {}
                eval_heur = prev_metrics.get("evalVsHeuristic", {}) or {}
        except Exception:
            pass

    loaded_existing = False
    if os.path.exists(latest_pt) and not args.fresh:
        try:
            ckpt = torch.load(latest_pt, map_location=device, weights_only=False)
            model.load_state_dict(ckpt["model_state_dict"])
            if "optimizer_state_dict" in ckpt:
                optimizer.load_state_dict(ckpt["optimizer_state_dict"])
            loaded_existing = True
            print(f"[RL] Loaded existing checkpoint from {latest_pt} (episode {start_episode})")
        except Exception as e:
            print(f"[RL] Starting fresh model ({e})")
    elif os.path.exists(latest_json) and not args.fresh:
        try:
            model.load_portable_weights(latest_json)
            loaded_existing = True
            print(f"[RL] Loaded portable weights from {latest_json}")
        except Exception:
            pass

    vec_bridge = VectorizedMarsBridge(
        num_workers=args.num_workers,
        envs_per_worker=args.envs_per_worker,
        mode=args.bridge_mode,
        server_url=args.server_url,
        repo_root=REPO_ROOT,
    )
    print(
        f"[RL] Connected via '{vec_bridge.mode}' bridge | "
        f"Workers: {vec_bridge.num_workers} | Envs/worker: {vec_bridge.envs_per_worker} "
        f"(Total parallel games: {vec_bridge.num_envs})"
    )

    try:
        if not loaded_existing and args.warmstart_steps > 0:
            print(f"[RL] Running {args.warmstart_steps} warm-start imitation steps on Tharsis 2P...")
            ws_loss = run_warmstart_imitation(vec_bridge.workers[0], model, optimizer, device, args.warmstart_steps)
            print(f"[RL] Warm-start completed (loss={ws_loss:.4f}). Exporting initial policy weights...")
            meta = {"version": 1, "step": total_steps, "episodes": start_episode, "winRate": 0.5, "avgVp": 72.0}
            model.save_portable_weights(latest_json, meta)
            if not os.path.exists(best_json):
                model.save_portable_weights(best_json, meta)

        episodes_done = 0
        episodes_launched = 0
        recent_vps: List[float] = []
        recent_trs: List[float] = []
        recent_wins: List[float] = []
        recent_gens: List[float] = []
        recent_heur_wins: List[float] = []
        recent_heur_vps: List[float] = []
        t_start = time.time()
        session_steps = 0

        if not eval_random:
            eval_random = evaluate_policy(vec_bridge, model, device, opponent_type="random", num_games=min(4, vec_bridge.num_envs))
        if not eval_heur:
            eval_heur = evaluate_policy(vec_bridge, model, device, opponent_type="heuristic", num_games=min(4, vec_bridge.num_envs))

        batch_states: List[np.ndarray] = []
        batch_masks: List[np.ndarray] = []
        batch_actions: List[int] = []
        batch_log_probs: List[float] = []
        batch_advantages: List[float] = []
        batch_returns: List[float] = []

        target_episodes = args.episodes
        num_active_slots = min(vec_bridge.num_envs, target_episodes)

        # Initialize all parallel slots
        slots: Dict[int, SlotState] = {}
        init_resets = []
        for slot in range(num_active_slots):
            ep_idx = start_episode + episodes_launched
            episodes_launched += 1
            use_h, rl_seat, opp_seat, auto_opp, p_names = make_slot_config(ep_idx, args.opponent)
            slots[slot] = SlotState(
                ep_idx=ep_idx,
                use_heuristic_opp=use_h,
                rl_seat=rl_seat,
                opp_seat=opp_seat,
                auto_opponent=auto_opp,
                player_names=p_names,
                trajectories=([], []),
                obs={},
            )
            init_resets.append(
                {
                    "slot": slot,
                    "playerNames": p_names,
                    "autoOpponent": auto_opp,
                    "autoOpponentSeat": opp_seat,
                }
            )

        init_obs_map = vec_bridge.reset_slots(init_resets)
        for slot, obs in init_obs_map.items():
            slots[slot].obs = obs

        while episodes_done < target_episodes and slots:
            model.eval()

            # 1. Process any slots that are already done (e.g. after auto-opponent move)
            done_slots = [s for s, st in list(slots.items()) if st.obs.get("done", False)]
            resets_needed = []
            for slot in done_slots:
                st = slots[slot]
                obs = st.obs
                for seat in (0, 1):
                    if len(st.trajectories[seat]) > 0:
                        st.trajectories[seat][-1].reward += float(obs["rewards"][seat])
                        st.trajectories[seat][-1].done = True
                        adv, ret = compute_gae_for_episode(st.trajectories[seat], args.gamma, args.gae_lambda)
                        for rec, a_val, r_val in zip(st.trajectories[seat], adv, ret):
                            batch_states.append(rec.state)
                            batch_masks.append(rec.mask)
                            batch_actions.append(rec.action)
                            batch_log_probs.append(rec.log_prob)
                            batch_advantages.append(float(a_val))
                            batch_returns.append(float(r_val))

                info = obs["info"]
                winner = info["winner"]
                if st.use_heuristic_opp:
                    rl_vp = info["p0Vp"] if st.rl_seat == 0 else info["p1Vp"]
                    rl_tr = info["p0Tr"] if st.rl_seat == 0 else info["p1Tr"]
                    won = 1.0 if winner == st.rl_seat else (0.5 if winner == -1 else 0.0)
                    recent_heur_wins.append(float(won))
                    recent_heur_vps.append(float(rl_vp))
                    if len(recent_heur_wins) > 30:
                        recent_heur_wins.pop(0)
                        recent_heur_vps.pop(0)
                else:
                    rl_vp = 0.5 * (info["p0Vp"] + info["p1Vp"])
                    rl_tr = 0.5 * (info["p0Tr"] + info["p1Tr"])
                    won = 1.0 if winner == 0 else (0.5 if winner == -1 else 0.0)

                recent_vps.append(float(rl_vp))
                recent_trs.append(float(rl_tr))
                recent_wins.append(float(won))
                recent_gens.append(float(obs["generation"]))
                if len(recent_vps) > 30:
                    recent_vps.pop(0)
                    recent_trs.pop(0)
                    recent_wins.pop(0)
                    recent_gens.pop(0)

                episodes_done += 1

                if episodes_launched < target_episodes:
                    new_ep_idx = start_episode + episodes_launched
                    episodes_launched += 1
                    use_h, rl_seat, opp_seat, auto_opp, p_names = make_slot_config(new_ep_idx, args.opponent)
                    slots[slot] = SlotState(
                        ep_idx=new_ep_idx,
                        use_heuristic_opp=use_h,
                        rl_seat=rl_seat,
                        opp_seat=opp_seat,
                        auto_opponent=auto_opp,
                        player_names=p_names,
                        trajectories=([], []),
                        obs={},
                    )
                    resets_needed.append(
                        {
                            "slot": slot,
                            "playerNames": p_names,
                            "autoOpponent": auto_opp,
                            "autoOpponentSeat": opp_seat,
                        }
                    )
                else:
                    del slots[slot]

            if resets_needed:
                new_obs_map = vec_bridge.reset_slots(resets_needed)
                for slot, obs in new_obs_map.items():
                    slots[slot].obs = obs

            # 2. Check if we should run a PPO update
            if done_slots and (len(batch_states) >= args.ppo_batch_steps or episodes_done >= target_episodes):
                model.train()
                b_states = torch.tensor(np.array(batch_states), dtype=torch.float32, device=device)
                b_masks = torch.tensor(np.array(batch_masks), dtype=torch.bool, device=device)
                b_actions = torch.tensor(np.array(batch_actions), dtype=torch.long, device=device)
                b_old_lp = torch.tensor(np.array(batch_log_probs), dtype=torch.float32, device=device)
                b_adv = torch.tensor(np.array(batch_advantages), dtype=torch.float32, device=device)
                b_ret = torch.tensor(np.array(batch_returns), dtype=torch.float32, device=device)

                if b_adv.numel() > 1:
                    b_adv = (b_adv - b_adv.mean()) / (b_adv.std() + 1e-8)

                n_samples = b_states.size(0)
                mb_size = min(args.minibatch_size, n_samples)
                p_losses, v_losses, ent_losses = [], [], []

                for _epoch in range(args.ppo_epochs):
                    perm = torch.randperm(n_samples, device=device)
                    for start in range(0, n_samples, mb_size):
                        mb_idx = perm[start : start + mb_size]
                        _, new_lp, entropy, new_val = model.get_action_and_value(
                            b_states[mb_idx],
                            b_masks[mb_idx],
                            b_actions[mb_idx],
                        )
                        logratio = new_lp - b_old_lp[mb_idx]
                        ratio = logratio.exp()

                        mb_adv = b_adv[mb_idx]
                        pg_loss1 = -mb_adv * ratio
                        pg_loss2 = -mb_adv * torch.clamp(ratio, 1.0 - args.clip_coef, 1.0 + args.clip_coef)
                        pg_loss = torch.max(pg_loss1, pg_loss2).mean()

                        v_loss = 0.5 * ((new_val - b_ret[mb_idx]) ** 2).mean()
                        ent_loss = entropy.mean()

                        loss = pg_loss - args.ent_coef * ent_loss + args.vf_coef * v_loss

                        optimizer.zero_grad()
                        loss.backward()
                        nn.utils.clip_grad_norm_(model.parameters(), args.max_grad_norm)
                        optimizer.step()

                        # Keep stats on-device to avoid a host sync per minibatch on GPU.
                        p_losses.append(pg_loss.detach())
                        v_losses.append(v_loss.detach())
                        ent_losses.append(ent_loss.detach())

                policy_loss_val = float(torch.stack(p_losses).mean().item()) if p_losses else 0.0
                value_loss_val = float(torch.stack(v_losses).mean().item()) if v_losses else 0.0
                entropy_val = float(torch.stack(ent_losses).mean().item()) if ent_losses else 0.0

                batch_states.clear()
                batch_masks.clear()
                batch_actions.clear()
                batch_log_probs.clear()
                batch_advantages.clear()
                batch_returns.clear()

                current_ep = start_episode + episodes_done
                avg_vp = float(np.mean(recent_vps)) if recent_vps else 0.0
                avg_tr = float(np.mean(recent_trs)) if recent_trs else 0.0
                win_rate = float(np.mean(recent_wins)) if recent_wins else 0.5
                avg_gen = float(np.mean(recent_gens)) if recent_gens else 14.0
                elapsed = max(0.1, time.time() - t_start)
                sps = int(session_steps / elapsed)

                meta = {
                    "version": 1,
                    "step": total_steps,
                    "episodes": current_ep,
                    "winRate": round(win_rate, 4),
                    "avgVp": round(avg_vp, 2),
                }

                torch.save(
                    {
                        "episode": current_ep,
                        "total_steps": total_steps,
                        "model_state_dict": model.state_dict(),
                        "optimizer_state_dict": optimizer.state_dict(),
                        "meta": meta,
                    },
                    latest_pt,
                )
                model.save_portable_weights(latest_json, meta)

                score = avg_vp + 25.0 * win_rate
                if score >= best_score:
                    best_score = score
                    torch.save(
                        {
                            "episode": current_ep,
                            "total_steps": total_steps,
                            "model_state_dict": model.state_dict(),
                            "optimizer_state_dict": optimizer.state_dict(),
                            "meta": meta,
                        },
                        best_pt,
                    )
                    model.save_portable_weights(best_json, meta)

                history_entry = {
                    "episode": current_ep,
                    "totalSteps": total_steps,
                    "avgVp": round(avg_vp, 2),
                    "avgTr": round(avg_tr, 2),
                    "winRate": round(win_rate, 3),
                    "avgGeneration": round(avg_gen, 2),
                    "policyLoss": round(policy_loss_val, 4),
                    "valueLoss": round(value_loss_val, 4),
                    "entropy": round(entropy_val, 4),
                    "sps": sps,
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                }
                history.append(history_entry)
                if len(history) > 200:
                    history = history[-200:]

                if recent_heur_wins:
                    eval_heur = {
                        "win_rate": round(float(np.mean(recent_heur_wins)), 3),
                        "avg_vp": round(float(np.mean(recent_heur_vps)), 2),
                        "avg_opp_vp": eval_heur.get("avg_opp_vp", 0.0),
                    }

                save_metrics_json(
                    metrics_path,
                    {
                        "status": "training" if episodes_done < target_episodes else "idle",
                        "updatedAt": datetime.now(timezone.utc).isoformat(),
                        "updatedAtMs": int(time.time() * 1000),
                        "episodesCompleted": current_ep,
                        "totalSteps": total_steps,
                        "bestScore": round(best_score, 2),
                        "latestAvgVp": round(avg_vp, 2),
                        "latestAvgTr": round(avg_tr, 2),
                        "latestWinRate": round(win_rate, 3),
                        "latestAvgGen": round(avg_gen, 2),
                        "latestSps": sps,
                        "numWorkers": vec_bridge.num_workers,
                        "envsPerWorker": vec_bridge.envs_per_worker,
                        "parallelEnvs": vec_bridge.num_envs,
                        "device": str(device),
                        "evalVsRandom": eval_random,
                        "evalVsHeuristic": eval_heur,
                        "history": history,
                    },
                )

                print(
                    f"[PPO] Ep {current_ep} | Steps {total_steps} ({sps} sps) | "
                    f"WinRate {win_rate*100:.1f}% | AvgVP {avg_vp:.1f} | AvgTR {avg_tr:.1f} | "
                    f"Gen {avg_gen:.1f} | PLoss {policy_loss_val:.4f} | VLoss {value_loss_val:.4f}"
                )
                model.eval()

            if episodes_done >= target_episodes or not slots:
                break

            # 3. Batched PyTorch forward pass across all active slots
            active_slot_ids = [s for s, st in slots.items() if not st.obs.get("done", False)]
            if not active_slot_ids:
                continue

            states_batch_np = np.empty((len(active_slot_ids), STATE_DIM), dtype=np.float32)
            masks_batch_np = np.empty((len(active_slot_ids), ACTION_DIM), dtype=bool)

            for i, slot in enumerate(active_slot_ids):
                st = slots[slot]
                obs = st.obs
                p_idx = obs["activePlayerIndex"]
                if len(st.trajectories[p_idx]) > 0:
                    st.trajectories[p_idx][-1].reward += float(obs["rewards"][p_idx])
                states_batch_np[i] = obs["state"]
                masks_batch_np[i] = obs["mask"]

            states_t = torch.from_numpy(states_batch_np).to(device)
            masks_t = torch.from_numpy(masks_batch_np).to(device)
            with torch.no_grad():
                acts_t, lps_t, _ents_t, vals_t = model.get_action_and_value(states_t, masks_t)

            acts_np = acts_t.cpu().numpy()
            lps_np = lps_t.cpu().numpy()
            vals_np = vals_t.cpu().numpy()

            step_reqs = []
            for i, slot in enumerate(active_slot_ids):
                st = slots[slot]
                obs = st.obs
                p_idx = obs["activePlayerIndex"]
                action = int(acts_np[i])
                st.trajectories[p_idx].append(
                    StepRecord(
                        state=states_batch_np[i].copy(),
                        mask=masks_batch_np[i].copy(),
                        action=action,
                        log_prob=float(lps_np[i]),
                        value=float(vals_np[i]),
                        reward=0.0,
                        done=False,
                    )
                )
                step_reqs.append(
                    {
                        "slot": slot,
                        "action": action,
                        "autoOpponent": st.auto_opponent,
                        "autoOpponentSeat": st.opp_seat,
                    }
                )

            # 4. Step all active slots in parallel across worker processes
            next_obs_map = vec_bridge.step_slots(step_reqs)
            for slot, next_obs in next_obs_map.items():
                prev_steps = slots[slot].obs.get("info", {}).get("stepsCount", 0)
                cur_steps = next_obs.get("info", {}).get("stepsCount", prev_steps + 1)
                delta_steps = max(1, cur_steps - prev_steps)
                total_steps += delta_steps
                session_steps += delta_steps
                slots[slot].obs = next_obs

        # Final evaluation against Random and Heuristic baselines in parallel
        eval_random = evaluate_policy(vec_bridge, model, device, opponent_type="random", num_games=6)
        eval_heur = evaluate_policy(vec_bridge, model, device, opponent_type="heuristic", num_games=6)
        print(
            f"[Eval vs Random]    WinRate: {eval_random['win_rate']*100:.1f}% | "
            f"AvgVP: {eval_random['avg_vp']:.1f} vs {eval_random['avg_opp_vp']:.1f}"
        )
        print(
            f"[Eval vs Heuristic] WinRate: {eval_heur['win_rate']*100:.1f}% | "
            f"AvgVP: {eval_heur['avg_vp']:.1f} vs {eval_heur['avg_opp_vp']:.1f}"
        )

        final_ep = start_episode + episodes_done
        elapsed_final = max(0.1, time.time() - t_start)
        final_sps = int(session_steps / elapsed_final)
        save_metrics_json(
            metrics_path,
            {
                "status": "idle",
                "updatedAt": datetime.now(timezone.utc).isoformat(),
                "updatedAtMs": int(time.time() * 1000),
                "episodesCompleted": final_ep,
                "totalSteps": total_steps,
                "bestScore": round(best_score, 2),
                "latestAvgVp": round(float(np.mean(recent_vps)) if recent_vps else 0.0, 2),
                "latestAvgTr": round(float(np.mean(recent_trs)) if recent_trs else 0.0, 2),
                "latestWinRate": round(float(np.mean(recent_wins)) if recent_wins else 0.5, 3),
                "latestAvgGen": round(float(np.mean(recent_gens)) if recent_gens else 14.0, 2),
                "latestSps": final_sps,
                "numWorkers": vec_bridge.num_workers,
                "envsPerWorker": vec_bridge.envs_per_worker,
                "parallelEnvs": vec_bridge.num_envs,
                "device": str(device),
                "evalVsRandom": eval_random,
                "evalVsHeuristic": eval_heur,
                "history": history,
            },
        )
    finally:
        vec_bridge.close()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Train Terraforming Mars RL Agent (Tharsis 2P, Base+CE+Prelude)")
    parser.add_argument("--episodes", type=int, default=40, help="Number of episodes to train")
    parser.add_argument("--num-workers", type=int, default=max(2, os.cpu_count() or 2), help="Number of parallel Node.js worker processes")
    parser.add_argument("--envs-per-worker", type=int, default=4, help="Environments per worker process")
    parser.add_argument("--ppo-batch-steps", type=int, default=1024, help="Steps per PPO update")
    parser.add_argument("--ppo-epochs", type=int, default=4, help="PPO epochs per rollout batch")
    parser.add_argument("--minibatch-size", type=int, default=256, help="PPO minibatch size")
    parser.add_argument("--lr", type=float, default=3e-4, help="Learning rate")
    parser.add_argument("--gamma", type=float, default=0.995, help="Discount factor")
    parser.add_argument("--gae-lambda", type=float, default=0.95, help="GAE lambda")
    parser.add_argument("--clip-coef", type=float, default=0.2, help="PPO clipping coefficient")
    parser.add_argument("--ent-coef", type=float, default=0.015, help="Entropy bonus coefficient")
    parser.add_argument("--vf-coef", type=float, default=0.5, help="Value loss coefficient")
    parser.add_argument("--max-grad-norm", type=float, default=0.5, help="Max gradient norm")
    parser.add_argument("--warmstart-steps", type=int, default=600, help="Warmstart imitation steps when starting fresh")
    parser.add_argument("--opponent", choices=["self", "heuristic", "mixed"], default="mixed")
    parser.add_argument("--bridge-mode", choices=["auto", "http", "stdio", "io"], default="stdio")
    parser.add_argument("--server-url", type=str, default="http://127.0.0.1:8080")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument(
        "--device",
        type=str,
        default=os.environ.get("TM_RL_DEVICE", "auto"),
        help="Training device: auto (CUDA if available), cpu, cuda, cuda:N, or mps. Env: TM_RL_DEVICE",
    )
    parser.add_argument("--no-tf32", action="store_true", help="Disable TF32 matmuls on CUDA (Ampere+)")
    parser.add_argument("--cpu", action="store_true", help="Force CPU (overrides --device)")
    parser.add_argument("--fresh", action="store_true", help="Ignore existing checkpoints and train from scratch")
    return parser.parse_args()


if __name__ == "__main__":
    train(parse_args())
