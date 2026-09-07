INSERT INTO destinations (slug,name,country,region,lat,lng,bbox,tz,live,place_count,last_ingest_at)
VALUES ('chiayi','Chiayi','TW','Asia',23.48,120.449,'[23.44,120.4,23.52,120.5]','Asia/Taipei',1,1279,datetime('now'))
ON CONFLICT(slug) DO UPDATE SET name=excluded.name,country=excluded.country,region=excluded.region,
 lat=excluded.lat,lng=excluded.lng,bbox=excluded.bbox,tz=excluded.tz,live=excluded.live,
 place_count=excluded.place_count,last_ingest_at=excluded.last_ingest_at;