-- LiveReport de diagnostico (solo lectura, sin parametros). Ver README.md, seccion LiveReport.
SELECT verificacion, detalle, cantidad
FROM (
    SELECT 1 AS orden, 'tareas_aguardar_firma_activas' AS verificacion, '' AS detalle, COUNT(*) AS cantidad
    FROM wsubworktask t
    WHERE UPPER(t.subworktask_title) LIKE 'AGUARDAR FIRMA%' AND t.subworktask_status = 2

    UNION ALL
    SELECT 2, 'por_mapa',
           COALESCE(d.name, '(sin nombre)') || ' | mapobjid ' || COALESCE(CAST(m.map_mapobjid AS VARCHAR), '(sin wmap)'),
           COUNT(*)
    FROM wsubworktask t
    JOIN wsubwork sw
           ON sw.subwork_workid = t.subworktask_workid AND sw.subwork_subworkid = t.subworktask_subworkid
    LEFT JOIN wmap m ON m.map_mapid = sw.subwork_mapid
    LEFT JOIN dtree d ON d.dataid = m.map_mapobjid
    WHERE UPPER(t.subworktask_title) LIKE 'AGUARDAR FIRMA%' AND t.subworktask_status = 2
    GROUP BY d.name, m.map_mapobjid

    UNION ALL
    SELECT 3, 'atributos_mapa_firma',
           'attrid ' || CAST(a.wf_attrid AS VARCHAR) || ' | tipo ' || CAST(a.wf_attrtype AS VARCHAR)
           || ' | ejemplo ' || COALESCE(MIN(a.wf_valstr), CAST(MIN(a.wf_valint) AS VARCHAR), ''),
           COUNT(*)
    FROM wsubworktask t
    JOIN wsubwork sw
           ON sw.subwork_workid = t.subworktask_workid AND sw.subwork_subworkid = t.subworktask_subworkid
    JOIN wmap m ON m.map_mapid = sw.subwork_mapid
    JOIN dtree d ON d.dataid = m.map_mapobjid AND d.name = 'Firma'
    JOIN wfattrdata a ON a.wf_id = t.subworktask_subworkid
    WHERE UPPER(t.subworktask_title) LIKE 'AGUARDAR FIRMA%' AND t.subworktask_status = 2
    GROUP BY a.wf_attrid, a.wf_attrtype

    UNION ALL
    SELECT 4, 'firma_sin_atributos_en_subworkid', '', COUNT(*)
    FROM wsubworktask t
    JOIN wsubwork sw
           ON sw.subwork_workid = t.subworktask_workid AND sw.subwork_subworkid = t.subworktask_subworkid
    JOIN wmap m ON m.map_mapid = sw.subwork_mapid
    JOIN dtree d ON d.dataid = m.map_mapobjid AND d.name = 'Firma'
    WHERE UPPER(t.subworktask_title) LIKE 'AGUARDAR FIRMA%' AND t.subworktask_status = 2
      AND NOT EXISTS (SELECT 1 FROM wfattrdata a WHERE a.wf_id = t.subworktask_subworkid)

    UNION ALL
    SELECT 5, 'firma_docid_no_numerico', '', COUNT(*)
    FROM wsubworktask t
    JOIN wsubwork sw
           ON sw.subwork_workid = t.subworktask_workid AND sw.subwork_subworkid = t.subworktask_subworkid
    JOIN wmap m ON m.map_mapid = sw.subwork_mapid
    JOIN dtree d ON d.dataid = m.map_mapobjid AND d.name = 'Firma'
    JOIN wfattrdata a ON a.wf_id = t.subworktask_subworkid AND a.wf_attrid = 6
    WHERE UPPER(t.subworktask_title) LIKE 'AGUARDAR FIRMA%' AND t.subworktask_status = 2
      AND COALESCE(a.wf_valstr, '') !~ '^[0-9]+$'

    UNION ALL
    SELECT 6, 'firma_empleado_sin_usuario', '', COUNT(*)
    FROM wsubworktask t
    JOIN wsubwork sw
           ON sw.subwork_workid = t.subworktask_workid AND sw.subwork_subworkid = t.subworktask_subworkid
    JOIN wmap m ON m.map_mapid = sw.subwork_mapid
    JOIN dtree d ON d.dataid = m.map_mapobjid AND d.name = 'Firma'
    LEFT JOIN wfattrdata a ON a.wf_id = t.subworktask_subworkid AND a.wf_attrid = 4
    LEFT JOIN kuaf k ON k.id = a.wf_valint
    WHERE UPPER(t.subworktask_title) LIKE 'AGUARDAR FIRMA%' AND t.subworktask_status = 2
      AND k.id IS NULL
) x
ORDER BY orden, detalle
