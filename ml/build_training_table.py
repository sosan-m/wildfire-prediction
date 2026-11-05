# build_training_table.py
# Turns the satellite exports and fire records into one big table for the model.
# One row = one cell in one 8-day period.

import glob
import json

import pandas as pd

PERIODS_PER_YEAR = 46
FIRST_YEAR = 2001
MAX_FILL = 3     # carry a clear value forward for at most 3 periods when it's cloudy

# How far ahead the model looks. Each step is 8 days.
#   1 = next 8 days,  3 = next 24 days,  4 = next 32 days
HORIZON = 3


# ------------------------------------------------------------------
# STEP 1: LOAD THE FEATURE FILES
# ------------------------------------------------------------------
files = sorted(glob.glob("data/features/mtkenya_features_*.csv"))
print("Feature files found:", files)

tables = []
for file_name in files:
    tables.append(pd.read_csv(file_name))

wide = pd.concat(tables, ignore_index=True)
wide = wide.drop_duplicates(["cell_id", "year"], keep="last")
print("Wide table:", wide.shape)


# ------------------------------------------------------------------
# STEP 2: RESHAPE SO EACH ROW IS ONE CELL IN ONE PERIOD
# ------------------------------------------------------------------
df = pd.wide_to_long(
    wide,
    stubnames=["ndvi", "ndmi", "lst", "rain"],
    i=["cell_id", "year"],
    j="period",
    sep="_p",
    suffix=r"\d+",
).reset_index()

df["period"] = df["period"].astype(int)

# t counts periods continuously: 2001 period 0 is t=0, 2002 period 0 is t=46, and so on
df["t"] = (df["year"] - FIRST_YEAR) * PERIODS_PER_YEAR + df["period"]

df = df.sort_values(["cell_id", "t"]).reset_index(drop=True)
print("Long table:", df.shape)


# ------------------------------------------------------------------
# STEP 3: FILL CLOUD GAPS, AND RECORD HOW OLD EACH VALUE IS
# ------------------------------------------------------------------
for column in ["ndvi", "lst"]:
    # the time of each clear reading (blank where it was cloudy)
    time_if_clear = df["t"].where(df[column].notna())
    # carry the last clear time forward within each cell
    last_clear_time = time_if_clear.groupby(df["cell_id"]).ffill()
    # age = how many periods ago the last clear reading was (0 = fresh)
    df[column + "_age"] = df["t"] - last_clear_time

for column in ["ndvi", "ndmi", "lst"]:
    df[column] = df.groupby("cell_id")[column].ffill(limit=MAX_FILL)


# ------------------------------------------------------------------
# STEP 4: RAINFALL TOTALS OVER THE LAST 3, 6 AND 12 PERIODS
# ------------------------------------------------------------------
for window in [3, 6, 12]:
    # "lambda s:" is a tiny function that adds up the last `window` values
    df[f"rain_{window}p"] = df.groupby("cell_id")["rain"].transform(
        lambda s: s.rolling(window, min_periods=window).sum()
    )


# ------------------------------------------------------------------
# STEP 5: ADD THE FIXED FEATURES (ELEVATION AND SLOPE)
# ------------------------------------------------------------------
with open("data/mtkenya_grid_1km.geojson") as file:
    grid_data = json.load(file)

properties_list = []
for feature in grid_data["features"]:
    properties_list.append(feature["properties"])
static = pd.DataFrame(properties_list)

df = df.merge(static[["cell_id", "elevation", "slope"]], on="cell_id", how="left")


# ------------------------------------------------------------------
# STEP 6: THE ANSWER COLUMNS
# ------------------------------------------------------------------
events = pd.read_csv("data/fire_events.csv")
events["t"] = (events["year"] - FIRST_YEAR) * PERIODS_PER_YEAR + events["period"]
fire_times = events[["cell_id", "t"]].drop_duplicates()

# fire_now = 1 if this cell is burning during this period
fire_now = fire_times.copy()
fire_now["fire_now"] = 1

# fire_next = 1 if a fire happens in any of the next HORIZON periods.
# Example: a fire at t=100 with HORIZON=3 marks rows t=99, 98 and 97 as positive.
positive_rows = []
for steps_ahead in range(1, HORIZON + 1):
    earlier = fire_times.copy()
    earlier["t"] = earlier["t"] - steps_ahead
    positive_rows.append(earlier)

fire_next = pd.concat(positive_rows).drop_duplicates()
fire_next["fire_next"] = 1

df = df.merge(fire_now, on=["cell_id", "t"], how="left")
df = df.merge(fire_next, on=["cell_id", "t"], how="left")
df["fire_now"] = df["fire_now"].fillna(0).astype("int8")
df["fire_next"] = df["fire_next"].fillna(0).astype("int8")


# ------------------------------------------------------------------
# STEP 7: CLEAN UP
# ------------------------------------------------------------------
rows_at_start = len(df)
positives_at_start = int(df["fire_next"].sum())

# The last few periods don't have a full look-ahead window, so drop them
last_period = df["t"].max()
df = df[df["t"] <= last_period - HORIZON]

# Skip rows where the cell is already burning: we want NEW fires only
df = df[df["fire_now"] == 0]

# Drop rows that are still missing key values
needed = ["ndvi", "ndmi", "lst", "rain_12p", "ndvi_age", "lst_age"]
df = df.dropna(subset=needed)

# Use less memory
for column in df.select_dtypes("float64").columns:
    df[column] = df[column].astype("float32")


# ------------------------------------------------------------------
# STEP 8: SUMMARY AND SAVE
# ------------------------------------------------------------------
positives = int(df["fire_next"].sum())
print(f"\nLook-ahead: {HORIZON} period(s) = {HORIZON * 8} days")
print("Rows kept:", len(df), "of", rows_at_start)
print("Positives (fire in the look-ahead window):", positives, "| before cleaning:", positives_at_start)
print("Roughly 1 positive in", round(len(df) / positives), "rows")

print("\nPositives per year:")
print(df.groupby("year")["fire_next"].sum())

output_file = f"data/training_table_h{HORIZON}.pkl"
df.to_pickle(output_file)
print("\nSaved", output_file)