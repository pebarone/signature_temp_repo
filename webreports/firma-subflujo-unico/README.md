# Set Attributes do sub-fluxo de firma único

Passo WebReports do início do sub-fluxo de firma compartilhado (Firma_Documental, 4194101), usado por Contratación e
Documental. Substitui o par "mover documento para o sub-fluxo / devolver ao pai" (11909168 / 11913119): o DocID aponta
para o nó **nos anexos do pai**, e o orquestrador grava o PDF assinado como nova versão desse nó. Só tags do WebReport:
sem LiveReport e sem atributo novo. Nos mapas pai de Contratación muda só a troca do sub-fluxo antigo pelo único.

## Regra do DocID

| Título do pai (`&WORKID WFINFO:TITLE`) | DocID |
|---|---|
| contém `documental` (sem diferenciar maiúsculas) | o documento anexado, como antes (com vários, fica o último) |
| qualquer outro | o único documento (SubType 144, como no SQL antigo) com `contrato`, `otrosi` ou `otrosí` no nome |
| qualquer outro, com nenhum ou mais de um | texto `SIN_CONTRATO_UNICO`: a página de envio para antes de chamar o servidor e oferece o botão "Contrato adjuntado" |

`AttachID` é sempre a pasta de anexos do pai. No Set Attributes antigo da Contratación ele era a pasta do sub-fluxo, para onde
o documento era movido. O orquestrador só usa o AttachID quando o nó do DocID sumiu: o PDF assinado vira um nó novo nessa
pasta. Agora ele cai direto no pai, sem depender do passo de devolver.

Um título sem "documental" cai na regra do contrato, e sem um contrato único o envio para na página de envio. O outro sentido **não** é
protegido: um fluxo que não é Documental mas tem "documental" no título (por exemplo, editado no início para
"Contratación - soporte documental") cai no ramo Documental e assina o último anexo.

## Sintaxe (Tag Guide do WebReports)

- `PATFIND:<padrão>` devolve TRUE ou FALSE se o padrão aparece no texto e ignora maiúsculas por padrão. `[...]` é classe
  de caracteres: `otros[iíÍ]` cobre otrosi, otrosí e OTROSÍ.
- `[LL_REPTAG_"texto"]` é a forma documentada de texto literal.
- `LL_WEBREPORT_IF` não tem operador de "contém" nem `OR`. Por isso a busca usa `PATFIND` e IFs aninhados.
- `WFINFO` não expõe o mapa (sem MAPID nem MAPNAME). `TITLE` é o título da instância do pai.

## Instalação

1. Troque o código do Set Attributes do Firma_Documental por `Set Attributes Firma.html`.
2. Nos mapas pai de Contratación, troque o sub-fluxo antigo pelo Firma_Documental. Os passos de mover o documento
   (11909168) e de devolvê-lo (11913119) ficam nos sub-mapas antigos e saem com eles. Confira que nenhum deles está no
   próprio mapa pai:
   - o mover tiraria o contrato dos anexos do pai, e a busca nunca o encontraria;
   - o devolver levaria ao pai o primeiro anexo do sub-fluxo.

## Sem contrato único

A página de envio (`webreports/firma-flujo-puro/Requisicion de Firma.html`, `validarDatos`) confere o DocID antes de
qualquer chamada. Com DocID que não é número num sub-fluxo, ela não reatribui a tarefa nem chama o servidor, e a tarefa fica
com o usuário.
- Com `SIN_CONTRATO_UNICO`, mostra "No hay un único contrato u otrosí en los adjuntos del flujo." e o botão
  **Contrato adjuntado**.
- Com qualquer outro valor (por exemplo, Documental sem anexo), mostra "El ID del documento (DocID) no es válido." e o botão
  **Documento adjuntado**.

O botão chama o ramo `accion=recalcular` da própria página.
- O ramo refaz a escolha com **a mesma regra deste Set Attributes** e grava DocID e Nombre del Documento com
  `WFACTION:SETATTR`. A regra está duplicada: mudar nos dois arquivos.
- O `SETWFATTR` não serve ali porque a página roda pela URL. Fora de um passo de workflow ele só devolve o valor, sem
  gravar (QA 23/10, ver `webreports/cancelacion/README.md`).
- Em seguida a página recarrega. Se ainda não houver documento válido, a mensagem começa com "Todavía...".
- O ramo só regrava quando o DocID atual não é número, e só em sub-fluxo. No fluxo puro o erro continua sem botão, porque
  ali o Set Attributes é outro.

Checklist do botão: `webreports/firma-flujo-puro/README.md`, seção "Ramo recalcular".

## VALIDAR NO QA

**31/10/2026:** o usuário testou no QA um Documental e uma Contratación de ponta a ponta, e os dois funcionaram. Os itens
abaixo que não entram no caminho feliz (nenhum ou vários contratos, títulos, PROD) continuam em aberto.

1. Títulos:
   - os pais de Documental contêm "documental" (no QA, `Flujo documental - Bienestar`);
   - nenhum título de Contratación contém, nem o padrão do mapa nem o que pode ser editado no início.

   Um Documental renomeado para na página de envio. Uma Contratación com "documental" no título assina o último anexo. Decisão de
   31/10/2026: manter "contém" (`PATFIND:"documental"`), sem restringir ao início do título. Se for preciso fechar esse
   caso, a troca é por `PATFIND:"%flujo documental"` (`%` = início).
2. `PATFIND` renderiza exatamente `TRUE`. Se render `true`, todo fluxo cai na regra do contrato: falha fechada, mas o
   Documental para.
3. O ramo não tomado do `IF` não executa os `SETWFATTR`. Rode um Documental com um anexo sem "contrato" no nome: o DocID
   precisa ser o número do anexo, não `SIN_CONTRATO_UNICO`.
4. As variáveis gravadas com `SETVAR` dentro do `LL_WEBREPORT_FOR` continuam valendo depois do `ENDFOR`.
   - `RECARRAY:<i>:SubType` renderiza `144` nos documentos (o mesmo padrão de `:DataID`/`:Name`).
   - Se o campo tiver outro nome, nada casa e toda Contratación para na página de envio. A falha é fechada.
5. `PATFIND:"otros[iíÍ]"` com o acento gravado no código do WebReport. Teste um anexo `OTROSÍ` e outro `otrosi`. Grafias
   com espaço ou hífen ("Otro Sí", "otro-si") não casam e param na página de envio. O padrão não foi ampliado de propósito: um mais
   largo, como `otro[ -]*s[iíÍ]`, também casaria "otro sistema" e poderia assinar o anexo errado.
6. `SETWFATTR:"DocID"` grava o texto `SIN_CONTRATO_UNICO`. O DocID precisa ser atributo de **texto** no Firma_Documental
   (no mapa Firma é tipo -1). Se for inteiro, o texto não grava e fica o DocID que veio do pai, o que pode levar o documento
   errado para assinatura.
7. O `OTCS_USER` consegue adicionar versão ao nó que está nos anexos do **pai**. Conferir no QA e em PROD.
8. O passo seguinte do pai (envio ao BW) encontra o contrato assinado, que é o mesmo nó na última versão.
9. Caem em `SIN_CONTRATO_UNICO`:
   - otrosí junto com o contrato original nos anexos;
   - "Contrato.docx" junto com "Contrato.pdf";
   - qualquer outro anexo com "contrato" no nome (por exemplo "Anexo al contrato").

   Decidir se é o esperado.
10. E-mails: este Set Attributes grava o `Email Firmante 1` a partir do usuário `Empleado` do pai em todos os fluxos.
    - O Set Attributes antigo da Contratación não gravava esse e-mail: as linhas estavam comentadas, e ele chegava de
      outro caminho.
    - Decisão de 31/10/2026: gravar sempre, por universalidade, mesmo sobrescrevendo.
    - Segundo o usuário, o e-mail sempre vem do `Empleado`, e o pai sempre o preenche. O `Empleado` vazio visto nos
      `Firma_Contratación_Inactivo` do QA era o atributo do **sub-fluxo**, que o Set Attributes antigo não copiava. Este
      lê do pai (`&WORKID`).
    - Com os dois e-mails, o Adobe recebe dois signatários em paralelo (`order: 1` nos dois, `server/infra/adobeClient.js`).
      Se só um vier preenchido, o acordo sai só para ele.
11. A página de envio publicada no 650835 é a versão do repo, com `validarDatos` (procure "DocID) no es válido" no código).
    - Só um cliente que pule a página chega ao servidor com DocID não numérico.
    - Nesse caso a pré-checagem do `/start` não valida as dicas: a tarefa é reatribuída e só depois sai o 422.
