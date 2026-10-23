-- ============================================================================
-- LiveReport: Cancelar Flujo de Firma (seleção)
-- Fonte de dados do WebReport "Cancelar Flujo de Firma.html" (mesma pasta), etapa A (buscar e marcar).
-- Lista os fluxos com a tarefa "Aguardar Firma" ATIVA, para o usuário marcar quais cancelar.
--
-- ESTE SQL NÃO FOI EXECUTADO EM NENHUM OTCS. Nomes de tabelas/colunas, códigos de status,
-- IDs de atributos e dialeto (SQL Server x Oracle) são os de que não há certeza: cada ponto
-- está marcado com "VALIDAR NO QA". Os trechos <<ASSIM>> são placeholders que precisam ser
-- substituídos antes de salvar o LiveReport (de propósito não são SQL válido: falham alto
-- em vez de devolver dados errados).
--
-- Colunas devolvidas (a ORDEM importa: a página lê por posição, [LL_REPTAG_1] ... [LL_REPTAG_8]):
--   1 WorkID      ID do workflow (pai). É o valor que vai para "ID Flujo a Cancelar".
--   2 SubWorkID   ID do subprocesso onde está a tarefa "Aguardar Firma".
--   3 Titulo      título do workflow.
--   4 Fecha       data de início do subprocesso.
--   5 IDEmpleado  atributo ID do empregado.
--   6 Nombre      atributo nome do empregado.
--   7 Cedula      atributo cédula.
--   8 Documento   atributo Nombre del Documento.
--   9 DataID      ID de um nó do Content para a checagem de permissão do LiveReport (ver abaixo).
--                 A página NÃO usa a coluna 9; ela existe só para o LiveReport.
--
-- Parâmetros do LiveReport (Parameters tab; na aba Parameters do WebReport, mapeie cada um
-- para o parâmetro de URL de mesmo nome que a página envia, todos em minúsculas):
--   :A1  idempleado   (igualdade exata; vazio = sem filtro)
--   :A2  nombre       (contém, sem diferenciar maiúsculas; vazio = sem filtro)
--   :A3  cedula       (igualdade exata)
--   :A4  documento    (contém, sem diferenciar maiúsculas)
--   :A5  desde        (AAAA-MM-DD, inclusive; vazio = sem filtro)
--   :A6  hasta        (AAAA-MM-DD, inclusive; vazio = sem filtro)
-- Cada parâmetro deve aceitar valor vazio (default ''). Parâmetro vazio => sem filtro.
-- VALIDAR NO QA: a sintaxe de parâmetros (:A1...) e como o WebReport os preenche pela URL.
--
-- Placeholders a substituir (descubra cada um no QA; consultas de ajuda ao final do arquivo):
--   <<STATUS_TAREA_ACTIVA>>   código de status de tarefa ativa em WSubWorkTask.
--   <<ATTR_ID_EMPLEADO>>      chave do atributo "ID" do empregado em <<TABLA_ATRIBUTOS>>.
--   <<ATTR_NOMBRE>>           chave do atributo com o nome do empregado.
--   <<ATTR_CEDULA>>           chave do atributo com a cédula.
--   <<ATTR_DOCUMENTO>>        chave do atributo "Nombre del Documento".
--   <<ATTR_DOCID>>            chave do atributo "DocID" (nó do documento do contrato).
-- ============================================================================

-- Dialeto: o texto abaixo usa construções aceitas por SQL Server e Oracle (CONCAT de dois
-- argumentos, COALESCE, LEFT JOIN, "IS NULL OR = ''"). Nos três pontos que diferem
-- (data, limite de linhas, conversão do DataID) estão as duas versões; fica ativa a Oracle.
-- VALIDAR NO QA: qual banco o OTCS do ambiente usa.

SELECT
    t.WorkID                      AS WorkID,          -- 1 VALIDAR NO QA: WSubWorkTask.WorkID
    t.SubWorkID                   AS SubWorkID,       -- 2
    w.Title                       AS Titulo,          -- 3 VALIDAR NO QA: coluna do título (WWork.Title?)
    sw.DateStarted                AS Fecha,           -- 4 VALIDAR NO QA: WSubWork.DateStarted? (início do subprocesso)
    a_id.ValStr                   AS IDEmpleado,      -- 5
    a_nom.ValStr                  AS Nombre,          -- 6
    a_ced.ValStr                  AS Cedula,          -- 7
    a_doc.ValStr                  AS Documento,       -- 8
    -- 9 DataID. Veja "Permissões" abaixo. Opção A (a que está ativa): o nó do documento do contrato.
    --   Oracle:
    TO_NUMBER(a_docid.ValStr)     AS DataID
    --   SQL Server (trocar a linha acima por esta):
    --   CAST(a_docid.ValStr AS BIGINT) AS DataID
    -- Opção B: o mapa do workflow (w.DataID). Existe sempre, mas a permissão do MAPA não diz
    --   se o usuário pode ver aquele contrato: só use se não houver o DocID no formulário.
    --   w.DataID AS DataID
FROM WSubWorkTask t                                   -- VALIDAR NO QA: nome das tabelas de workflow
JOIN WSubWork sw
       ON sw.WorkID = t.WorkID AND sw.SubWorkID = t.SubWorkID
JOIN WWork w
       ON w.WorkID = t.WorkID
-- Atributos do formulário. VALIDAR NO QA: tabela (<<TABLA_ATRIBUTOS>>; candidata WWorkData),
-- colunas de chave/valor e se o atributo está no subprocesso ou no workflow pai. Se estiver
-- no pai, troque "a.SubWorkID = t.SubWorkID" por "a.SubWorkID = 0" (ou remova a condição).
LEFT JOIN <<TABLA_ATRIBUTOS>> a_id
       ON a_id.WorkID = t.WorkID AND a_id.SubWorkID = t.SubWorkID AND a_id.AttrKey = '<<ATTR_ID_EMPLEADO>>'
LEFT JOIN <<TABLA_ATRIBUTOS>> a_nom
       ON a_nom.WorkID = t.WorkID AND a_nom.SubWorkID = t.SubWorkID AND a_nom.AttrKey = '<<ATTR_NOMBRE>>'
LEFT JOIN <<TABLA_ATRIBUTOS>> a_ced
       ON a_ced.WorkID = t.WorkID AND a_ced.SubWorkID = t.SubWorkID AND a_ced.AttrKey = '<<ATTR_CEDULA>>'
LEFT JOIN <<TABLA_ATRIBUTOS>> a_doc
       ON a_doc.WorkID = t.WorkID AND a_doc.SubWorkID = t.SubWorkID AND a_doc.AttrKey = '<<ATTR_DOCUMENTO>>'
LEFT JOIN <<TABLA_ATRIBUTOS>> a_docid
       ON a_docid.WorkID = t.WorkID AND a_docid.SubWorkID = t.SubWorkID AND a_docid.AttrKey = '<<ATTR_DOCID>>'
WHERE
    -- Tarefa "Aguardar Firma" ativa. VALIDAR NO QA: coluna do nome da tarefa (WSubWorkTask.Title?),
    -- se o nome vem com prefixo/sufixo (o orquestrador normaliza prefixos) e o código de ativa.
    UPPER(t.Title) LIKE 'AGUARDAR FIRMA%'
    AND t.Status = <<STATUS_TAREA_ACTIVA>>
    -- Filtros. Parâmetro vazio = sem filtro. "IS NULL OR = ''" funciona em Oracle (onde '' é NULL)
    -- e em SQL Server (onde '' não é NULL).
    AND (:A1 IS NULL OR :A1 = '' OR a_id.ValStr = :A1)
    AND (:A2 IS NULL OR :A2 = '' OR UPPER(a_nom.ValStr) LIKE CONCAT('%', CONCAT(UPPER(:A2), '%')))
    AND (:A3 IS NULL OR :A3 = '' OR a_ced.ValStr = :A3)
    AND (:A4 IS NULL OR :A4 = '' OR UPPER(a_doc.ValStr) LIKE CONCAT('%', CONCAT(UPPER(:A4), '%')))
    -- Datas (AAAA-MM-DD). "hasta" é inclusivo: compara com o dia seguinte, exclusivo.
    --   Oracle:
    AND (:A5 IS NULL OR :A5 = '' OR sw.DateStarted >= TO_DATE(:A5, 'YYYY-MM-DD'))
    AND (:A6 IS NULL OR :A6 = '' OR sw.DateStarted <  TO_DATE(:A6, 'YYYY-MM-DD') + 1)
    --   SQL Server (trocar as duas linhas acima por estas):
    --   AND (:A5 IS NULL OR :A5 = '' OR sw.DateStarted >= CONVERT(date, :A5, 23))
    --   AND (:A6 IS NULL OR :A6 = '' OR sw.DateStarted <  DATEADD(day, 1, CONVERT(date, :A6, 23)))
ORDER BY sw.DateStarted DESC, t.WorkID DESC
-- Limite de linhas: prefira a configuração de limite do próprio LiveReport. Se preferir no SQL:
--   Oracle 12c+:  FETCH FIRST 500 ROWS ONLY
--   SQL Server:   troque "SELECT" por "SELECT TOP 500" (e remova o ORDER BY se o LiveReport reclamar)
-- Não termine o SQL do LiveReport com ponto e vírgula (o Oracle recusa).

-- ============================================================================
-- Permissões (VALIDAR NO QA)
-- ============================================================================
-- O LiveReport tem uma opção para checar permissões do usuário que o executa sobre as linhas,
-- usando uma coluna chamada DataID (permissão "See" sobre aquele nó). Com a opção A acima, o usuário
-- só vê os fluxos cujo documento do contrato ele pode ver. Confirme no QA: (1) o nome exato da
-- opção na versão instalada, (2) que ela exclui linhas e não apenas esconde a coluna, (3) que um
-- usuário sem acesso ao documento não vê a linha. O WebReport executa o LiveReport com as
-- permissões de quem abre a página? (VALIDAR NO QA; há configuração de usuário de execução.)
--
-- Alternativa (e mais simples, recomendada se a checagem acima não se confirmar): RESTRINGIR O
-- WEBREPORT A UM GRUPO. Dê permissão "See Contents"/"Run" sobre o nó do WebReport (e do LiveReport) só
-- ao grupo que pode cancelar fluxos de firma. Quem não tem a permissão nem abre a página. A página
-- não amplia o acesso: só grava a lista no atributo do workflow de cancelamento.
--
-- ============================================================================
-- Consultas de ajuda para descobrir os placeholders no QA (rode uma a uma, com um WorkID conhecido)
-- ============================================================================
--   -- colunas e status das tarefas do subprocesso:
--   SELECT * FROM WSubWorkTask WHERE WorkID = <WorkID de um fluxo em Aguardar Firma>;
--   -- onde ficam os atributos do formulário e como se identificam:
--   SELECT * FROM <<TABLA_ATRIBUTOS>> WHERE WorkID = <o mesmo WorkID>;
--   -- título e mapa do workflow:
--   SELECT * FROM WWork WHERE WorkID = <o mesmo WorkID>;
--   SELECT * FROM WSubWork WHERE WorkID = <o mesmo WorkID>;
-- Compare o resultado com a tarefa vista na UI do Content para fechar o código de "ativa".
