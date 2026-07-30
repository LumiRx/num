INSERT INTO destinations (slug,name,country,region,lat,lng,bbox,tz,live,place_count,last_ingest_at)
VALUES ('new-york','New York','US','Americas',40.713,-74.006,'[40.66,-74.03,40.88,-73.9]','America/New_York',1,19992,datetime('now'))
ON CONFLICT(slug) DO UPDATE SET name=excluded.name,country=excluded.country,region=excluded.region,
 lat=excluded.lat,lng=excluded.lng,bbox=excluded.bbox,tz=excluded.tz,live=excluded.live,
 place_count=excluded.place_count,last_ingest_at=excluded.last_ingest_at;