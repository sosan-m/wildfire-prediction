var grid = ee.FeatureCollection('projects/wildfire-risk-508811/assets/mtkenya_grid_1km')
  .select(['cell_id']);

// CHANGE THESE TWO LINES for each run
var START_YEAR = 2021, END_YEAR = 2025;

var mod09 = ee.ImageCollection('MODIS/061/MOD09A1');
var lst = ee.ImageCollection('MODIS/061/MOD11A1');
var chirps = ee.ImageCollection('UCSB-CHG/CHIRPS/DAILY');
var proj1km = mod09.first().select('sur_refl_b01').projection().atScale(1000);
var proj500 = mod09.first().select('sur_refl_b01').projection();

// Placeholders used when an image is missing (they come out blank in the CSV)
var emptyMod = ee.Image.constant([0, 0, 0, 1])
  .rename(['sur_refl_b01', 'sur_refl_b02', 'sur_refl_b06', 'StateQA']).toInt32();
var emptyBand = ee.Image.constant(0).updateMask(0);

function safeMean(coll, band) {
  return ee.Image(ee.Algorithms.If(coll.size().gt(0), coll.select(band).mean(), emptyBand));
}
function safeSum(coll, band) {
  return ee.Image(ee.Algorithms.If(coll.size().gt(0), coll.select(band).sum(), emptyBand));
}

function tag(p) { return (p < 10 ? '0' : '') + p; }

function periodImage(year, p) {
  var yStart = ee.Date.fromYMD(year, 1, 1);
  var yEnd = ee.Date.fromYMD(year + 1, 1, 1);
  var start = yStart.advance(p * 8, 'day');
  var end = ee.Date(ee.Algorithms.If(
    start.advance(8, 'day').millis().gt(yEnd.millis()), yEnd, start.advance(8, 'day')));

  var comps = mod09.filterDate(start, start.advance(1, 'day'));
  var c = ee.Image(ee.Algorithms.If(comps.size().gt(0), comps.first(), emptyMod))
  .setDefaultProjection(proj500);
  var red = c.select('sur_refl_b01'), nir = c.select('sur_refl_b02'),
      swir = c.select('sur_refl_b06');
  var ok = c.select('StateQA').bitwiseAnd(3).eq(0)
    .and(red.gt(0)).and(nir.gt(0)).and(swir.gt(0));

  var ndvi = nir.subtract(red).divide(nir.add(red)).updateMask(ok)
    .rename('ndvi_p' + tag(p))
    .reduceResolution({reducer: ee.Reducer.mean(), maxPixels: 64}).reproject(proj1km);
  var ndmi = nir.subtract(swir).divide(nir.add(swir)).updateMask(ok)
    .rename('ndmi_p' + tag(p))
    .reduceResolution({reducer: ee.Reducer.mean(), maxPixels: 64}).reproject(proj1km);
  var lstDay = safeMean(lst.filterDate(start, end), 'LST_Day_1km')
    .multiply(0.02).subtract(273.15).rename('lst_p' + tag(p));
  var rain = safeSum(chirps.filterDate(start, end), 'precipitation')
    .rename('rain_p' + tag(p));
  return ee.Image.cat([ndvi, ndmi, lstDay, rain]);
}

var cols = ['cell_id', 'year'];
for (var p = 0; p < 46; p++) {
  cols.push('ndvi_p' + tag(p), 'ndmi_p' + tag(p), 'lst_p' + tag(p), 'rain_p' + tag(p));
}

var tables = [];
for (var y = START_YEAR; y <= END_YEAR; y++) {
  var bands = [];
  for (var q = 0; q < 46; q++) bands.push(periodImage(y, q));
  tables.push(ee.Image.cat(bands).reduceRegions({
    collection: grid, reducer: ee.Reducer.mean(), scale: 1000, tileScale: 4
  }).map((function (yr) {
    return function (f) { return f.set('year', yr); };
  })(y)));
}

Export.table.toDrive({
  collection: ee.FeatureCollection(tables).flatten(),
  description: 'mtkenya_features_' + START_YEAR + '_' + END_YEAR,
  fileFormat: 'CSV',
  selectors: cols
});