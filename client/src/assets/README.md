# Bundled land outline

`ne_110m_land.json` is Natural Earth's 1:110m land GeoJSON dataset, obtained from the [Natural Earth vector repository](https://github.com/nvkelso/natural-earth-vector/blob/master/geojson/ne_110m_land.geojson). [Natural Earth places its map data in the public domain](https://www.naturalearthdata.com/about/terms-of-use/). It is bundled with MemoryLane as the offline and loading/error fallback. Detailed online maps request OpenStreetMap tiles; turning off Detailed online map uses this outline without remote tile requests.
