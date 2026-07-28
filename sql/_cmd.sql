INSERT INTO destinations (slug,name,country,region,lat,lng,bbox,tz,live,place_count,last_ingest_at)
VALUES ('bridgetown','Barbados','BB','Islands',13.098,-59.617,'[13.03,-59.68,13.2,-59.53]','America/Barbados',1,912,datetime('now'))
ON CONFLICT(slug) DO UPDATE SET name=excluded.name,country=excluded.country,region=excluded.region,
 lat=excluded.lat,lng=excluded.lng,bbox=excluded.bbox,tz=excluded.tz,live=excluded.live,
 place_count=excluded.place_count,last_ingest_at=excluded.last_ingest_at;