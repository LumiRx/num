INSERT INTO destinations (slug,name,country,region,lat,lng,bbox,tz,live,place_count,last_ingest_at)
VALUES ('terelj','Gorkhi-Terelj','MN','Asia',47.983,107.467,'[47.85,107.28,48.16,107.72]','Asia/Ulaanbaatar',1,20,datetime('now'))
ON CONFLICT(slug) DO UPDATE SET name=excluded.name,country=excluded.country,region=excluded.region,
 lat=excluded.lat,lng=excluded.lng,bbox=excluded.bbox,tz=excluded.tz,live=excluded.live,
 place_count=excluded.place_count,last_ingest_at=excluded.last_ingest_at;