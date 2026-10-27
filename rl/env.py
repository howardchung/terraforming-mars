from concurrent.futures import ThreadPoolExecutor
import http.client
import json
import os
import subprocess
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlparse


class TerraformingMarsBridge:
    """
    Fast bridge between Python RL training and the Node.js Terraforming Mars engine.
    Supports:
      - 'http' mode: persistent HTTP keep-alive connection to the live Terraforming Mars
        server (/api/rl) so all training games are registered in GameLoader and viewable
        live in the Terraforming Mars Web UI (/spectator?id=...).
      - 'stdio' / 'io' mode: spawns a dedicated headless Node.js worker process over stdin/stdout.
      - 'auto' mode: uses 'http' if the web server is reachable, else falls back to 'stdio'.
    """

    def __init__(
        self,
        mode: str = "stdio",
        server_url: str = "http://127.0.0.1:8080",
        repo_root: Optional[str] = None,
    ) -> None:
        self.repo_root = repo_root or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        self.server_url = server_url
        parsed = urlparse(server_url)
        self.host = parsed.hostname or "127.0.0.1"
        self.port = parsed.port or 8080

        self.proc: Optional[subprocess.Popen] = None
        self.http_conn: Optional[http.client.HTTPConnection] = None

        if mode == "auto":
            if self._check_http_alive():
                self.mode = "http"
            else:
                self.mode = "stdio"
        elif mode == "io":
            self.mode = "stdio"
        else:
            self.mode = mode

        if self.mode == "stdio":
            self._start_stdio_worker()
        else:
            self._connect_http()

    def _check_http_alive(self) -> bool:
        try:
            conn = http.client.HTTPConnection(self.host, self.port, timeout=1.5)
            conn.request("GET", "/api/rl")
            resp = conn.getresponse()
            resp.read()
            conn.close()
            return resp.status == 200
        except Exception:
            return False

    def _connect_http(self) -> None:
        self.http_conn = http.client.HTTPConnection(self.host, self.port, timeout=30.0)

    def _http_post(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        body = json.dumps(payload).encode("utf-8")
        headers = {"Content-Type": "application/json", "Connection": "keep-alive"}
        for attempt in range(2):
            try:
                if self.http_conn is None:
                    self._connect_http()
                assert self.http_conn is not None
                self.http_conn.request("POST", "/api/rl", body=body, headers=headers)
                resp = self.http_conn.getresponse()
                raw = resp.read().decode("utf-8")
                return json.loads(raw)
            except Exception:
                self.http_conn = None
                if attempt == 1:
                    raise
        raise RuntimeError("HTTP request to /api/rl failed")

    def _start_stdio_worker(self) -> None:
        compiled_worker = os.path.join(self.repo_root, "build", "src", "server", "rl", "rl_stdio_worker.js")
        if os.path.exists(compiled_worker):
            cmd = ["node", compiled_worker]
        else:
            cmd = ["npx", "tsx", "src/server/rl/rl_stdio_worker.ts"]

        self.proc = subprocess.Popen(
            cmd,
            cwd=self.repo_root,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        res = self._stdio_send({"cmd": "info"})
        if not res.get("ok"):
            raise RuntimeError(f"Failed to initialize RL stdio worker: {res}")

    def _stdio_send(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        if self.proc is None or self.proc.stdin is None or self.proc.stdout is None:
            raise RuntimeError("Stdio worker is not running")
        self.proc.stdin.write(json.dumps(payload) + "\n")
        self.proc.stdin.flush()
        while True:
            line = self.proc.stdout.readline()
            if not line:
                err_out = self.proc.stderr.read() if self.proc.stderr else ""
                raise RuntimeError(f"RL stdio worker EOF. Stderr: {err_out}")
            line_s = line.strip()
            if line_s.startswith("{") and line_s.endswith("}"):
                return json.loads(line_s)

    def reset(
        self,
        env_id: str = "env_0",
        seed: Optional[float] = None,
        player_names: Optional[Tuple[str, str]] = None,
        auto_opponent: Optional[str] = None,
        auto_opponent_seat: int = 1,
    ) -> Dict[str, Any]:
        if self.mode == "http":
            res = self._http_post(
                {
                    "action": "env_reset",
                    "envId": env_id,
                    "seed": seed,
                    "playerNames": list(player_names) if player_names else None,
                }
            )
            return res["obs"]
        else:
            res = self._stdio_send(
                {
                    "cmd": "reset",
                    "envId": env_id,
                    "seed": seed,
                    "playerNames": list(player_names) if player_names else None,
                    "autoOpponent": auto_opponent,
                    "autoOpponentSeat": auto_opponent_seat,
                }
            )
            return res["obs"]

    def batch_reset(self, items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        if self.mode == "http":
            results = []
            for item in items:
                obs = self.reset(
                    env_id=item["envId"],
                    seed=item.get("seed"),
                    player_names=item.get("playerNames"),
                )
                results.append({"obs": obs})
            return results
        else:
            res = self._stdio_send({"cmd": "batch_reset", "items": items})
            return res["results"]

    def step(
        self,
        env_id: str,
        action_index: int,
        auto_opponent: Optional[str] = None,
        auto_opponent_seat: int = 1,
    ) -> Dict[str, Any]:
        if self.mode == "http":
            res = self._http_post(
                {
                    "action": "env_step",
                    "envId": env_id,
                    "actionIndex": int(action_index),
                }
            )
            return res["obs"]
        else:
            res = self._stdio_send(
                {
                    "cmd": "step",
                    "envId": env_id,
                    "action": int(action_index),
                    "autoOpponent": auto_opponent,
                    "autoOpponentSeat": auto_opponent_seat,
                }
            )
            return res["obs"]

    def heuristic_action(self, env_id: str) -> int:
        if self.mode == "http":
            res = self._http_post({"action": "env_heuristic", "envId": env_id})
            return int(res["action"])
        else:
            res = self._stdio_send({"cmd": "heuristic_action", "envId": env_id})
            return int(res["action"])

    def batch_step(
        self,
        items: List[Dict[str, Any]],
        auto_reset: bool = False,
    ) -> List[Dict[str, Any]]:
        if self.mode == "http":
            res = self._http_post(
                {
                    "action": "env_batch_step",
                    "items": items,
                    "autoReset": auto_reset,
                }
            )
            return res["results"]
        else:
            res = self._stdio_send(
                {
                    "cmd": "batch_step",
                    "items": items,
                    "autoReset": auto_reset,
                }
            )
            return res["results"]

    def close(self) -> None:
        if self.http_conn is not None:
            try:
                self.http_conn.close()
            except Exception:
                pass
            self.http_conn = None
        if self.proc is not None:
            try:
                self.proc.terminate()
                self.proc.wait(timeout=2)
            except Exception:
                pass
            self.proc = None


class VectorizedMarsBridge:
    """
    Parallel multi-process vectorized environment bridge.
    Spawns `num_workers` independent Node.js worker processes, each managing
    `envs_per_worker` environments concurrently (`total_envs = num_workers * envs_per_worker`).
    Uses a ThreadPoolExecutor to dispatch batched IPC calls across all worker processes
    in parallel while PyTorch evaluates all `total_envs` states in a single batched forward pass.
    """

    def __init__(
        self,
        num_workers: int = 2,
        envs_per_worker: int = 4,
        mode: str = "stdio",
        server_url: str = "http://127.0.0.1:8080",
        repo_root: Optional[str] = None,
    ) -> None:
        self.num_workers = max(1, int(num_workers))
        self.envs_per_worker = max(1, int(envs_per_worker))
        self.num_envs = self.num_workers * self.envs_per_worker
        self.workers = [
            TerraformingMarsBridge(mode=mode, server_url=server_url, repo_root=repo_root)
            for _ in range(self.num_workers)
        ]
        self.mode = self.workers[0].mode
        self.executor = ThreadPoolExecutor(max_workers=self.num_workers)

    def slot_to_worker(self, slot: int) -> Tuple[int, str]:
        w_idx = slot // self.envs_per_worker
        env_id = f"w{w_idx}_env_{slot % self.envs_per_worker}"
        return w_idx, env_id

    def reset_slots(self, slot_configs: List[Dict[str, Any]]) -> Dict[int, Dict[str, Any]]:
        """
        Resets a list of environment slots in parallel across worker processes.
        Each item in `slot_configs` has:
          - slot: int (0 .. num_envs - 1)
          - seed: Optional[float]
          - playerNames: Optional[Tuple[str, str]]
          - autoOpponent: Optional['heuristic' | 'random']
          - autoOpponentSeat: Optional[int]
        Returns a dict mapping `slot -> obs`.
        """
        per_worker: Dict[int, List[Tuple[int, Dict[str, Any]]]] = {}
        for cfg in slot_configs:
            slot = int(cfg["slot"])
            w_idx, env_id = self.slot_to_worker(slot)
            item = {
                "envId": env_id,
                "seed": cfg.get("seed"),
                "playerNames": list(cfg["playerNames"]) if cfg.get("playerNames") else None,
                "autoOpponent": cfg.get("autoOpponent"),
                "autoOpponentSeat": cfg.get("autoOpponentSeat", 1),
            }
            per_worker.setdefault(w_idx, []).append((slot, item))

        futures = {}
        for w_idx, pairs in per_worker.items():
            items = [p[1] for p in pairs]
            futures[w_idx] = (
                [p[0] for p in pairs],
                self.executor.submit(self.workers[w_idx].batch_reset, items),
            )

        out: Dict[int, Dict[str, Any]] = {}
        for w_idx, (slots, fut) in futures.items():
            results = fut.result()
            for slot, res in zip(slots, results):
                out[slot] = res["obs"]
        return out

    def step_slots(self, slot_actions: List[Dict[str, Any]]) -> Dict[int, Dict[str, Any]]:
        """
        Steps a list of environment slots in parallel across worker processes.
        Each item in `slot_actions` has:
          - slot: int (0 .. num_envs - 1)
          - action: int
          - autoOpponent: Optional['heuristic' | 'random']
          - autoOpponentSeat: Optional[int]
        Returns a dict mapping `slot -> obs`.
        """
        per_worker: Dict[int, List[Tuple[int, Dict[str, Any]]]] = {}
        for sa in slot_actions:
            slot = int(sa["slot"])
            w_idx, env_id = self.slot_to_worker(slot)
            item = {
                "envId": env_id,
                "action": int(sa["action"]),
                "autoOpponent": sa.get("autoOpponent"),
                "autoOpponentSeat": sa.get("autoOpponentSeat", 1),
            }
            per_worker.setdefault(w_idx, []).append((slot, item))

        futures = {}
        for w_idx, pairs in per_worker.items():
            items = [p[1] for p in pairs]
            futures[w_idx] = (
                [p[0] for p in pairs],
                self.executor.submit(self.workers[w_idx].batch_step, items, False),
            )

        out: Dict[int, Dict[str, Any]] = {}
        for w_idx, (slots, fut) in futures.items():
            results = fut.result()
            for slot, res in zip(slots, results):
                out[slot] = res["obs"]
        return out

    def close(self) -> None:
        self.executor.shutdown(wait=False)
        for w in self.workers:
            w.close()
