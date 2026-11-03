import glob
import json

import pandas as pd

N_PER = 46        # 8-day periods per year
BASE_YEAR = 2001
MAX_FILL = 3      # carry a value forward at most 3 periods (~24 days)

# 1. Load the feature files -------------------------------------------------
files = sorted(glob.glob("data/features/mtkenya_features_*.csv"))
print("Feature files found:", files)
wide = pd.concat([pd.read_csv(f) for f in files], ignore_index=True)
wide = wide.drop_duplicates(["cell_id", "year"], keep="last")
print("Wide table:", wide.shape, "| years:", wide.year.min(), "to", wide.year.max())

# 2. Wide -> long: one row per cell, year and period ---------------------------
df = pd.wide_to_long(
    wide, stubnames=["ndvi", "ndmi", "lst", "rain"],
    i=["cell_id", "year"], j="period", sep="_p", suffix=r"\d+",
).reset_index()
df["period"] = df["period"].astype(int)
df["t"] = (df["year"] - BASE_YEAR) * N_PER + df["period"]   # continuous time index
df = df.sort_values(["cell_id", "t"]).reset_index(drop=True)
print("Long table:", df.shape)

# 3. Fill cloud gaps and record how old each value is ------------------------
for var in ["ndvi", "lst"]:
    last_t = df["t"].where(df[var].notna())
    last_t = last_t.groupby(df["cell_id"]).ffill()
    df[var + "_age"] = df["t"] - last_t          # 0 = fresh, 3 = three periods old
for var in ["ndvi", "ndmi", "lst"]:
    df[var] = df.groupby("cell_id")[var].ffill(limit=MAX_FILL)

# 4. Rainfall totals over the last 3, 6 and 12 periods -------------------------
for w in (3, 6, 12):
    df[f"rain_{w}p"] = df.groupby("cell_id")["rain"].transform(
        lambda s: s.rolling(w, min_periods=w).sum()
    )

# 5. Fixed features from the grid file ---------------------------------------
with open("data/mtkenya_grid_1km.geojson") as f:
    gj = json.load(f)
static = pd.DataFrame([ft["properties"] for ft in gj["features"]])
df = df.merge(static[["cell_id", "elevation", "slope"]], on="cell_id", how="left")

# 6. Labels: did a fire start in the NEXT period? ----------------------------
events = pd.read_csv("data/fire_events.csv")
events["t"] = (events["year"] - BASE_YEAR) * N_PER + events["period"]
ev = events[["cell_id", "t"]].drop_duplicates()
fire_now = ev.assign(fire_now=1)
fire_next = ev.assign(t=ev["t"] - 1, fire_next=1)[["cell_id", "t", "fire_next"]]
df = (df.merge(fire_now, on=["cell_id", "t"], how="left")
        .merge(fire_next, on=["cell_id", "t"], how="left"))
df[["fire_now", "fire_next"]] = df[["fire_now", "fire_next"]].fillna(0).astype("int8")

# 7. Clean up ------------------------------------------------------------------
n_start = len(df)
pos_start = int(df["fire_next"].sum())
df = df[df["t"] < df["t"].max()]            # last period has no "next"
df = df[df["fire_now"] == 0]                # predict new ignitions only
core = ["ndvi", "ndmi", "lst", "rain_12p", "ndvi_age", "lst_age"]
df = df.dropna(subset=core)

for c in df.select_dtypes("float64").columns:
    df[c] = df[c].astype("float32")

# 8. Summary and save ----------------------------------------------------------
print("\nRows kept:", len(df), "of", n_start)
print("Positives (fire starts next period):", int(df.fire_next.sum()), "| before cleaning:", pos_start)
print("Roughly 1 positive in", round(len(df) / max(df.fire_next.sum(), 1)), "rows")
print("\nPositives per year:")
print(df.groupby("year")["fire_next"].sum())
print("\nFeature summary:")
print(df[core + ["rain_3p", "rain_6p", "elevation", "slope"]].describe().T[["count", "mean", "min", "max"]])

df.to_pickle("data/training_table.pkl")
print("\nSaved data/training_table.pkl")