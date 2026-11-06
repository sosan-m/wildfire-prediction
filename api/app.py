import datetime as dt
import json
from pathlib import Path

import pandas as pd
from flask import Flask, jsonify, request, send_from_directory

ROOT = Path(__file__).resolve().parent.parent
app = Flask(__name__, static_folder=str(ROOT / "web"), static_url_path="")

PERIODS_PER_YEAR = 46
FIRST_YEAR = 2001

# ------------------------------------------------------------------
# Grid with fire history
# ------------------------------------------------------------------
with open(ROOT / "data" / "mtkenya_grid_1km.geojson") as f:
    GRID = json.load(f)

events = pd.read_csv(ROOT / "data" / "fire_events.csv")
years_burned = events.groupby("cell_id")["year"].nunique().to_dict()
n_events = events.groupby("cell_id").size().to_dict()
for feat in GRID["features"]:
    cid = feat["properties"]["cell_id"]
    feat["properties"]["years_burned"] = int(years_burned.get(cid, 0))
    feat["properties"]["fire_events"] = int(n_events.get(cid, 0))

# ------------------------------------------------------------------
# Predicted risk (held-out-year scores)
# ------------------------------------------------------------------
ALL = pd.read_pickle(ROOT / "data" / "risk_scores.pkl")

# Track record of each risk band in the back-test
NAMES = ["Low", "Moderate", "High", "Very High"]
overall = ALL["fire_next"].mean()
g = ALL.groupby("band")["fire_next"].agg(["size", "sum"]).reindex(range(4)).fillna(0)
BAND_STATS = []
for b in range(4):
    n, fires = float(g.loc[b, "size"]), float(g.loc[b, "sum"])
    rate = fires / n if n else 0
    BAND_STATS.append({
        "name": NAMES[b],
        "one_in": round(1 / rate) if rate else None,
        "lift": round(rate / overall, 1) if overall else 0,
    })
print("Band track record:", BAND_STATS)

SCORES = ALL.set_index(["year", "period"]).sort_index()

# Scores grouped by cell, for the cell-detail panel
ALL["t"] = (ALL["year"] - FIRST_YEAR) * PERIODS_PER_YEAR + ALL["period"]
SCORES_BY_CELL = {cid: grp.set_index("t") for cid, grp in ALL.groupby("cell_id", observed=True)}

# ------------------------------------------------------------------
# Satellite conditions, grouped by cell (also for the cell-detail panel)
# ------------------------------------------------------------------
cols = ["cell_id", "t", "ndvi", "ndmi", "lst", "rain", "ndvi_age", "lst_age"]
FEATS = pd.read_pickle(ROOT / "data" / "training_table.pkl")[cols]
FEATS_BY_CELL = {cid: grp.set_index("t") for cid, grp in FEATS.groupby("cell_id")}
del FEATS
print("Data loaded. Server ready.")


def number(value, digits):
    """Round a number, or return None if it is missing (JSON cannot hold NaN)."""
    if value is None or pd.isna(value):
        return None
    return round(float(value), digits)


def period_label(year, period):
    start = dt.date(year, 1, 1) + dt.timedelta(days=period * 8)
    return f"{start.day} {start.strftime('%b')}"


# ------------------------------------------------------------------
# Routes
# ------------------------------------------------------------------
@app.route("/")
def home():
    return send_from_directory(app.static_folder, "index.html")

@app.route("/about")
def about():
    return send_from_directory(app.static_folder, "about.html")


@app.route("/api/grid")
def grid():
    return jsonify(GRID)


@app.route("/api/risk")
def risk():
    year = request.args.get("year", type=int)
    period = request.args.get("period", type=int)
    if year is None or period is None:
        return jsonify({"error": "year and period are required"}), 400

    start = dt.date(year, 1, 1) + dt.timedelta(days=period * 8)
    end = min(start + dt.timedelta(days=7), dt.date(year, 12, 31))
    try:
        rows = SCORES.loc[[(year, period)]]
    except KeyError:
        rows = SCORES.iloc[0:0]

    # cell_id -> [score, band, fire_started_next_period]
    cells = {r.cell_id: [round(float(r.score), 4), int(r.band), int(r.fire_next)]
             for r in rows.itertuples()}
    return jsonify({"year": year, "period": period, "start": start.isoformat(),
                    "end": end.isoformat(), "cells": cells, "bands": BAND_STATS})


@app.route("/api/cell")
def cell_history():
    cell_id = request.args.get("cell_id")
    year = request.args.get("year", type=int)
    period = request.args.get("period", type=int)
    if not cell_id or year is None or period is None:
        return jsonify({"error": "cell_id, year and period are required"}), 400

    t_now = (year - FIRST_YEAR) * PERIODS_PER_YEAR + period
    feats = FEATS_BY_CELL.get(cell_id)
    scores = SCORES_BY_CELL.get(cell_id)

    history = []
    for t in range(max(0, t_now - 11), t_now + 1):      # the last 12 periods
        y = FIRST_YEAR + t // PERIODS_PER_YEAR
        p = t % PERIODS_PER_YEAR
        row = {"year": y, "period": p, "label": period_label(y, p),
               "ndvi": None, "ndmi": None, "lst": None, "rain": None,
               "ndvi_age": None, "lst_age": None,
               "score": None, "band": None, "fire_next": None}
        if feats is not None and t in feats.index:
            f = feats.loc[t]
            row["ndvi"] = number(f["ndvi"], 3)
            row["ndmi"] = number(f["ndmi"], 3)
            row["lst"] = number(f["lst"], 2)
            row["rain"] = number(f["rain"], 1)
            row["ndvi_age"] = number(f["ndvi_age"], 0)
            row["lst_age"] = number(f["lst_age"], 0)
        if scores is not None and t in scores.index:
            s = scores.loc[t]
            row["score"] = number(s["score"], 4)
            row["band"] = int(s["band"])
            row["fire_next"] = int(s["fire_next"])
        history.append(row)

    return jsonify({"cell_id": cell_id, "history": history})


if __name__ == "__main__":
    app.run(debug=True)