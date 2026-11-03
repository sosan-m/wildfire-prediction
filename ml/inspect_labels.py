import re
import pandas as pd

raw = pd.read_csv("data/mtkenya_fire_labels.csv")
print(raw.shape)
print(raw.head())

# Unpack the histogram column, e.g. "{12=3, 13=1}" -> one row per burned period
rows = []
for _, r in raw.iterrows():
    for period, count in re.findall(r"(\d+)(?:\.\d+)?=([\d.]+)", str(r["histogram"])):
        rows.append({
            "cell_id": r["cell_id"],
            "year": int(r["year"]),
            "period": int(period),
            "burned_px": float(count),
        })

events = pd.DataFrame(rows)
events.to_csv("data/fire_events.csv", index=False)

print("Fire events (cell + year + period):", len(events))
print("Cells that ever burned:", events.cell_id.nunique(), "of 1996")
print(events.groupby("year").size())
print(events.period.value_counts().sort_index())