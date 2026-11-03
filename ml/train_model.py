# train_model.py
# What this script does:
#   1. Loads the training table
#   2. Tests the model fairly: train on some years, test on years it has never seen
#   3. Compares the model with a simple "fire history" baseline
#   4. Saves a risk score and risk band for every cell and period (used by the map)
#   5. Trains a final model on all the data and saves it

import json

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import average_precision_score, roc_auc_score


# ------------------------------------------------------------------
# SETTINGS
# ------------------------------------------------------------------
# The columns the model is allowed to look at
FEATURES = [
    "ndvi", "ndmi", "lst", "rain", "rain_3p", "rain_6p", "rain_12p",
    "ndvi_age", "lst_age", "elevation", "slope", "period",
]

# Fires are very rare, so for training we keep every fire row
# but only 30 "no fire" rows for each fire row
NO_FIRE_PER_FIRE = 30

# A random number generator with a fixed seed, so results are repeatable
rng = np.random.default_rng(0)


# ------------------------------------------------------------------
# STEP 1: LOAD THE DATA
# ------------------------------------------------------------------
df = pd.read_pickle("data/training_table.pkl")
print("Loaded", df.shape)


# ------------------------------------------------------------------
# STEP 2: SPLIT THE YEARS INTO 5 GROUPS
# ------------------------------------------------------------------
# We test on whole years the model has never seen. We make 5 groups of
# years, each with a similar number of fires, so every test is fair.

# Count the fires in each year, biggest year first
fires_per_year = df.groupby("year")["fire_next"].sum()
fires_per_year = fires_per_year.sort_values(ascending=False)

fold_years = [[], [], [], [], []]   # the years in each of the 5 groups
fold_fires = [0, 0, 0, 0, 0]        # total fires in each group so far

for year, fires_in_year in fires_per_year.items():
    # Put this year into whichever group has the fewest fires so far
    lightest_group = fold_fires.index(min(fold_fires))
    fold_years[lightest_group].append(int(year))
    fold_fires[lightest_group] += int(fires_in_year)

print("Held-out year groups:", fold_years)
print("Fires per group:", fold_fires, "\n")


# ------------------------------------------------------------------
# HELPER FUNCTIONS
# ------------------------------------------------------------------
def make_model():
    """Create a new, untrained Random Forest."""
    model = RandomForestClassifier(
        n_estimators=300,                  # number of trees
        min_samples_leaf=5,                # stops trees from memorising single rows
        n_jobs=-1,                         # use all CPU cores
        random_state=0,                    # makes results repeatable
        class_weight="balanced_subsample", # pay extra attention to the rare fires
    )
    return model


def pick_training_rows(train):
    """Keep all the fire rows plus a random sample of the no-fire rows."""
    fire_rows = train[train["fire_next"] == 1]
    no_fire_rows = train[train["fire_next"] == 0]

    how_many_no_fire = len(fire_rows) * NO_FIRE_PER_FIRE
    no_fire_sample = no_fire_rows.sample(n=how_many_no_fire, random_state=0)

    return pd.concat([fire_rows, no_fire_sample])


def evaluate(actual, scores):
    """
    Measure how good a set of scores is.
    Returns two numbers:
      pr_auc        - the main score for rare events (higher is better)
      share_caught  - the share of all fires that land in the top 1% of scores
    """
    pr_auc = average_precision_score(actual, scores)

    # Many rows can have the same score. Add a tiny random amount to each
    # score so that ties are broken randomly instead of unfairly.
    scores = scores + rng.random(len(scores)) * 1e-9

    # Find the top 1% of rows by score
    number_in_top = int(0.01 * len(scores))
    positions_best_first = np.argsort(-scores)   # row positions, highest score first
    top_positions = positions_best_first[:number_in_top]

    # How many of the real fires are inside that top 1%?
    fires_in_top = actual[top_positions].sum()
    share_caught = fires_in_top / actual.sum()

    return pr_auc, share_caught


# ------------------------------------------------------------------
# STEP 3: TEST THE MODEL, ONE GROUP OF YEARS AT A TIME
# ------------------------------------------------------------------
scored_tables = []        # the scores for every cell-period, collected here
all_actual = []           # what really happened (1 = fire, 0 = no fire)
all_model_scores = []     # the model's scores
all_baseline_scores = []  # the baseline's scores

for fold_number in range(5):
    test_years = fold_years[fold_number]

    # Split the table: rows from the test years vs all the other years
    is_test_row = df["year"].isin(test_years)
    test = df[is_test_row]
    train = df[~is_test_row]

    # Train the model on the training years only
    training_rows = pick_training_rows(train)
    model = make_model()
    model.fit(training_rows[FEATURES], training_rows["fire_next"])

    # Score every row in the test years.
    # predict_proba gives two columns: [no fire, fire]. We want the fire one.
    model_scores = model.predict_proba(test[FEATURES])[:, 1]

    # Keep these scores - the map will use them
    fold_table = test[["cell_id", "year", "period", "fire_next"]].copy()
    fold_table["score"] = model_scores
    scored_tables.append(fold_table)

    # The baseline: score each cell by how often it burned in the training years
    burn_rate_per_cell = train.groupby("cell_id")["fire_next"].mean()
    baseline_scores = test["cell_id"].map(burn_rate_per_cell)
    baseline_scores = baseline_scores.fillna(0).to_numpy()

    # Compare both against what really happened
    actual = test["fire_next"].to_numpy()
    model_pr, model_caught = evaluate(actual, model_scores)
    base_pr, base_caught = evaluate(actual, baseline_scores)

    print(f"Fold {fold_number + 1} (test years {test_years}, {int(actual.sum())} fires)")
    print(f"   model    PR-AUC {model_pr:.4f} | top-1% catches {model_caught:.1%}")
    print(f"   baseline PR-AUC {base_pr:.4f} | top-1% catches {base_caught:.1%}")

    all_actual.append(actual)
    all_model_scores.append(model_scores)
    all_baseline_scores.append(baseline_scores)


# ------------------------------------------------------------------
# STEP 4: COMBINE ALL 5 TESTS INTO ONE OVERALL RESULT
# ------------------------------------------------------------------
actual = np.concatenate(all_actual)
model_scores = np.concatenate(all_model_scores)
baseline_scores = np.concatenate(all_baseline_scores)


def print_overall(name, actual, scores):
    pr_auc, share_caught = evaluate(actual, scores)
    roc_auc = roc_auc_score(actual, scores)
    print(f"{name}: PR-AUC {pr_auc:.4f} | ROC-AUC {roc_auc:.3f} "
          f"| top 1% catches {share_caught:.1%} of fires")


print("\n=== All folds pooled ===")
print(f"Random guessing PR-AUC would be about {actual.mean():.5f}")
print_overall("Model", actual, model_scores)
print_overall("Fire-history baseline", actual, baseline_scores)


# ------------------------------------------------------------------
# STEP 5: TURN SCORES INTO RISK BANDS FOR THE MAP
# ------------------------------------------------------------------
# Put the scores from all 5 tests into one big table
scores_table = pd.concat(scored_tables, ignore_index=True)

# Bands are based on percentiles of the scores:
#   below the 80th percentile      -> 0 = Low
#   80th to 95th percentile        -> 1 = Moderate
#   95th to 99th percentile        -> 2 = High
#   above the 99th percentile      -> 3 = Very High
cut_80 = scores_table["score"].quantile(0.80)
cut_95 = scores_table["score"].quantile(0.95)
cut_99 = scores_table["score"].quantile(0.99)
cuts = [cut_80, cut_95, cut_99]

# np.digitize gives each score a band number 0, 1, 2 or 3 using the cut points
scores_table["band"] = np.digitize(scores_table["score"], cuts).astype("int8")

# Save for the website
scores_table["cell_id"] = scores_table["cell_id"].astype("category")
scores_table.to_pickle("data/risk_scores.pkl")

band_info = {"cuts": cuts, "names": ["Low", "Moderate", "High", "Very High"]}
with open("data/risk_bands.json", "w") as file:
    json.dump(band_info, file)

# Check: the share of fires should rise from Low to Very High
by_band = scores_table.groupby("band")["fire_next"].agg(n_rows="size", fires="sum")
by_band["share_of_fires"] = (by_band["fires"] / by_band["fires"].sum()).round(3)
print("\nFires by risk band (0=Low, 3=Very High):")
print(by_band)


# ------------------------------------------------------------------
# STEP 6: TRAIN THE FINAL MODEL ON ALL YEARS AND SAVE IT
# ------------------------------------------------------------------
training_rows = pick_training_rows(df)
final_model = make_model()
final_model.fit(training_rows[FEATURES], training_rows["fire_next"])

# Which features did the model rely on most?
importance = pd.Series(final_model.feature_importances_, index=FEATURES)
importance = importance.sort_values(ascending=False)
print("\nFeature importance:")
print(importance.round(3))

joblib.dump({"model": final_model, "features": FEATURES}, "ml/model.joblib")
print("\nSaved ml/model.joblib")