import json
import numpy as np
import matplotlib.pyplot as plt
from pathlib import Path

# -----------------------------
# Inputs
# -----------------------------
# Point this at whatever run you want to plot (your 999-file WHILE run, etc.)
RUN_JSON = "A:\My Stuff\Projects\Python Stuff\Realtime Grammar Inferesing\grammar_output\while_test_grammar.json"

# TreeVada paper-reported runtime for WHILE (Table 1): t[s] = 16
# (Note: this is a reported value from the ICSE'24 TreeVada paper, not your local run.)
TREEVADA_WHILE_WALL_SECONDS_REPORTED = 16.0

# -----------------------------
# Load your run JSON
# -----------------------------
p = Path(RUN_JSON)
if not p.exists():
    raise FileNotFoundError(f"Could not find {RUN_JSON} in the current folder.")

with p.open("r", encoding="utf-8") as f:
    data = json.load(f)

bench = data.get("bench", {}) or {}
pm = data.get("power_metrics", {}) or {}

# Prefer power_metrics.wall_seconds if present; otherwise fall back to bench.wall_ms
this_wall_s = pm.get("wall_seconds", None)
if this_wall_s is None:
    this_wall_s = float(bench.get("wall_ms", 0.0)) / 1000.0
else:
    this_wall_s = float(this_wall_s)

files_used = int(bench.get("files_used", 0) or 0)

# -----------------------------
# Data for plot
# -----------------------------
systems = ["This work", "TreeVada \npaper-reported\nseed-dependent"]
wall_times = [this_wall_s, TREEVADA_WHILE_WALL_SECONDS_REPORTED]

x = np.arange(len(systems))

# -----------------------------
# Figure
# -----------------------------
fig, ax = plt.subplots(figsize=(7, 3.6))

bar_width = 0.28  # narrower bars
bars = ax.bar(x, wall_times, width=bar_width)

# Visually mark TreeVada as "reported" (not measured in your environment)
bars[1].set_hatch("//")
bars[1].set_edgecolor("black")
bars[1].set_linewidth(1.0)

# -----------------------------
# Labels & title (linear axis)
# -----------------------------
ax.set_ylabel("Wall time (seconds)")
if files_used > 0:
    ax.set_title(f"Grammar inference on WHILE benchmark ({files_used} programs)")
else:
    ax.set_title("Grammar inference on WHILE benchmark")

ax.set_xticks(x)
ax.set_xticklabels(systems)

# Linear axis + sensible headroom
ymax = max(wall_times) if max(wall_times) > 0 else 1.0
ax.set_ylim(0, ymax * 1.15)

# -----------------------------
# Annotations
# -----------------------------
for i, (b, t) in enumerate(zip(bars, wall_times)):
    label = f"{t:.3f}s" if t < 10 else f"{t:.0f}s"
    ax.text(
        b.get_x() + b.get_width() / 2,
        b.get_height(),
        label,
        ha="center",
        va="bottom",
        fontsize=10,
    )

plt.tight_layout()
plt.show()
