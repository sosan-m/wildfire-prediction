import pandas as pd

s = pd.read_pickle("data/risk_scores.pkl")
total_fires = s["fire_next"].sum()

print("Across all cell-periods:")
for pct in (1, 5, 10, 20, 30):
    thr = s["score"].quantile(1 - pct / 100)
    caught = s.loc[s["score"] >= thr, "fire_next"].sum() / total_fires
    print(f"  top {pct}% catches {caught:.1%} of new fires")

# Within each 8-day period: where does a fire cell rank among the ~1,900?
s["rank"] = s.groupby(["year", "period"])["score"].rank(ascending=False, method="first")
fires = s[s["fire_next"] == 1]
print("\nWithin a period (rank among about 1,900 cells):")
for k in (20, 50, 100, 200, 400):
    print(f"  fire cell is in the top {k}: {(fires['rank'] <= k).mean():.1%}")
print("  median rank of a fire cell:", int(fires["rank"].median()))