import argparse, json, os, glob, random, time, sys

def load_traces(dir_path, sample=300):
  traces = []
  for fp in glob.glob(os.path.join(dir_path, "*.txt")):
    with open(fp, "r", encoding="utf-8") as f:
      for line in f:
        s = line.strip()
        if s:
          traces.append(s)
  random.seed(0)
  random.shuffle(traces)
  return traces[:sample]

def infer_stub(traces, time_budget):
  t0 = time.time()
  time.sleep(min(0.05, max(0.0, time_budget/4.0)))
  toks = set()
  for t in traces[:200]:
    toks.update([w for w in t.split() if w])
  toks = sorted(toks)[:5] or ['a','b','c']
  terminals = ", ".join(toks)
  grammar = f"""grammar Preview;
  terminals: {terminals};
  start: S;
  S -> {toks[0]} S | {toks[-1]} ;
  """
  coverage = 1.0 if traces else 0.0
  metrics = {"coverage": coverage, "conflicts": 0, "mdl": max(1.0, 100.0 - len(toks)*3)}
  changes = {"added": [f"S -> {toks[0]} S"], "removed": []}
  return grammar, metrics, changes

if __name__ == "__main__":
  ap = argparse.ArgumentParser()
  ap.add_argument("--dir", required=True)
  ap.add_argument("--sample", type=int, default=300)
  ap.add_argument("--time_budget", type=float, default=0.4)
  ap.add_argument("--json", action="store_true")
  args = ap.parse_args()

  traces = load_traces(args.dir, args.sample)
  grammar, metrics, changes = infer_stub(traces, args.time_budget)
  if args.json:
    print(json.dumps({"grammar": grammar, "metrics": metrics, "changes": changes}))
  else:
    print(grammar)
