-- LiveReport Cancelar Flujo de Firma (PostgreSQL). Solo datos, sin parametros: filtros y reglas en el WebReport.
-- Documentacion: README.md de esta carpeta, seccion LiveReport. Sin punto y coma al final.
SELECT
    t.subworktask_workid                      AS WorkID,
    t.subworktask_subworkid                   AS SubWorkID,
    p.subwork_title                           AS TituloFlujo,
    sw.subwork_title                          AS TituloFirma,
    d.name                                    AS Mapa,
    TO_CHAR(sw.subwork_dateinitiated, 'YYYY-MM-DD HH24:MI') AS Fecha,
    sw.subwork_status                         AS EstadoSubflujo,
    (
        SELECT CAST(JSON_AGG(JSON_BUILD_OBJECT(
                   'id', a.wf_attrid,
                   't',  a.wf_attrtype,
                   'n',  a.wf_entrynum,
                   's',  a.wf_valstr,
                   'i',  a.wf_valint,
                   'login',  k.name,
                   'nombre', NULLIF(TRIM(CONCAT_WS(' ', k.firstname, k.middlename, k.lastname)), '')
               ) ORDER BY a.wf_attrid, a.wf_entrynum) AS VARCHAR)
        FROM wfattrdata a
        LEFT JOIN kuaf k
               ON a.wf_attrtype = 14 AND k.id = a.wf_valint
        WHERE a.wf_id = t.subworktask_subworkid
    )                                         AS Atributos
FROM wsubworktask t
JOIN wsubwork sw
       ON sw.subwork_workid = t.subworktask_workid AND sw.subwork_subworkid = t.subworktask_subworkid
LEFT JOIN wsubwork p
       ON p.subwork_workid = t.subworktask_workid AND p.subwork_subworkid = t.subworktask_workid
LEFT JOIN wmap m
       ON m.map_mapid = sw.subwork_mapid
LEFT JOIN dtree d
       ON d.dataid = m.map_mapobjid
WHERE
    UPPER(t.subworktask_title) LIKE 'AGUARDAR FIRMA%'
    AND t.subworktask_status = 2
ORDER BY sw.subwork_dateinitiated DESC, t.subworktask_workid DESC
