var region = ee.FeatureCollection('WCMC/WDPA/current/polygons')
  .filterBounds(ee.Geometry.Rectangle([37.0, -0.6, 37.8, 0.3]))
  .filter(ee.Filter.stringContains('NAME', 'Mount Kenya'))
  .geometry();

// 1 km version of the MODIS grid, so cells line up with the satellite data
var modisProj = ee.ImageCollection('MODIS/061/MOD09A1').first()
  .select('sur_refl_b01').projection().atScale(1000);

// One point per 1 km pixel centre that falls inside the boundary
var centers = ee.Image.constant(1).reproject(modisProj).clip(region)
  .sample({region: region, projection: modisProj, scale: 1000, geometries: true});

// Turn each centre into a 1 km square with a stable ID
var cells = centers.map(function (f) {
  var c = f.geometry().coordinates();
  var lon = ee.Number(c.get(0)), lat = ee.Number(c.get(1));
  var id = lon.multiply(10000).round().format('%d').cat('_')
              .cat(lat.multiply(10000).round().format('%d'));
  return ee.Feature(f.geometry().buffer(500, 1).bounds(),
                    {cell_id: id, lon: lon, lat: lat});
});

// Static features: mean elevation and slope per cell
var dem = ee.Image('USGS/SRTMGL1_003');
var stat = dem.select('elevation').addBands(ee.Terrain.slope(dem));
var grid = stat.reduceRegions({
  collection: cells, reducer: ee.Reducer.mean(), scale: 30
});

print('Number of cells', grid.size());
print('Sample cell', grid.first());
Map.centerObject(region, 9);
Map.addLayer(grid, {color: 'orange'}, 'Grid');

Export.table.toDrive({
  collection: grid,
  description: 'mtkenya_grid_1km',
  fileFormat: 'GeoJSON'
});
Export.table.toAsset({
  collection: grid,
  description: 'mtkenya_grid_1km_asset',
  assetId: 'mtkenya_grid_1km'
});