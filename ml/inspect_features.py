import pandas as pd

df = pd.read_csv("data/features/mtkenya_features_2021_2025.csv")
print(df.shape)                      # expect about (9980, 186)
print(df.groupby("year").size())     # expect 1996 rows per year

ndvi_cols = [c for c in df.columns if c.startswith("ndvi_")]
print("Share of blank NDVI values:", round(df[ndvi_cols].isna().mean().mean(), 3))

# Periods where EVERY cell is blank = the composite was missing entirely
all_blank = df[ndvi_cols].isna().all()
print("Fully blank NDVI periods:", all_blank[all_blank].index.tolist())

print(df[["ndvi_p10", "ndmi_p10", "lst_p10", "rain_p10"]].describe())