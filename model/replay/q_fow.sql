SELECT tick, team, ent, vis FROM (
  SELECT tick, "m_iTeamNum" AS team, unnest("m_vecFOWEntities__m_nEntIndex") AS ent,
    unnest("m_vecFOWEntities__m_bVisibleOnMap") AS vis
  FROM CCitadelTeam WHERE tick % 16 = 0 AND "m_iTeamNum" IN (2, 3)
) WHERE ent > 1 AND ent < 1000
