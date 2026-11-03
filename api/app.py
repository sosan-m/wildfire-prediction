import datetime as dt
import json
from pathlib import Path

import pandas as pd
from flask import Flask, jsonify, request, send_from_directory

ROOT = Path(__file__).resolve().parent.parent
app = Flask(__name__, static_folder=str(ROOT / "web"), static_url_path="")

# --- Grid with fire history ---
with open(ROOT / "data" / "mtkenya_grid_1km.geojson") as f:
    GRID = json.load(f)

events = pd.read_csv(ROOT / "data" / "fire_events.csv")
years_burned = events.groupby("cell_id")["year"].nunique().to_dict()
n_events = events.groupby("cell_id").size().to_dict()
for feat in GRID["features"]:
    cid = feat["properties"]["cell_id"]
    feat["properties"]["years_burned"] = int(years_burned.get(cid, 0))
    feat["properties"]["fire_events"] = int(n_events.get(cid, 0))

# --- Predicted risk from the held-out-year model ---
ALL = pd.read_pickle(ROOT / "data" / "risk_scores.pkl")

# Track record of each band in the back-test: how often did a new fire follow?
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


@app.route("/")
def home():
    return send_from_directory(app.static_folder, "index.html")


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


if __name__ == "__main__":
    app.run(debug=True)