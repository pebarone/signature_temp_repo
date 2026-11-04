#!/bin/sh
# Checagem antes de aplicar um overlay do orquestrador (padrão: prod). Não altera nada no cluster.
#
# Uso, a partir da raiz do repositório:
#   sh deploy/openshift/check.sh                    # verifica deploy/openshift/prod
#   sh deploy/openshift/check.sh <pasta-do-overlay>
#
# Confere params.env e secret.env (codificação, formato e valores), renderiza o overlay com oc kustomize e, se houver
# sessão no oc, lê o namespace, a StorageClass e a Route (somente leitura).
# Nunca mostra valores de secret.env. A saída do kustomize só aparece quando não há secret.env, porque ela pode repetir
# linhas do arquivo. Com erro de arquivo ou de codificação, o render nem é executado.
# Sai com código 1 se houver ERROR. AVISO não bloqueia.
set -u
# Compara bytes, não caracteres: o resultado não depende da localidade do terminal
LC_ALL=C
export LC_ALL

DIR="${1:-$(dirname "$0")/prod}"
ERROS=0
AVISOS=0
BLOQUEIO=0   # 1 = não renderizar (arquivo ausente, linha inválida ou codificação ruim)

erro() { ERROS=$((ERROS + 1)); echo "ERROR: $*"; }
aviso() { AVISOS=$((AVISOS + 1)); echo "AVISO: $*"; }
ok() { echo "OK: $*"; }

# Pasta temporária para listas e para a saída do kustomize (que tem Secret em base64).
# Removida na saída normal e nas interrupções (Ctrl-C, TERM, HUP).
TMP=$(mktemp -d) || { echo "ERROR: no fue posible crear una carpeta temporal"; exit 1; }
trap 'rm -rf "$TMP"' EXIT
trap 'rm -rf "$TMP"; exit 129' HUP
trap 'rm -rf "$TMP"; exit 130' INT
trap 'rm -rf "$TMP"; exit 143' TERM

TAB=$(printf '\t')
P="$DIR/params.env"
S="$DIR/secret.env"
CHAVES_PARAMS="NAMESPACE PUBLIC_URL IMAGE STORAGE_CLASS STORAGE_SIZE OTCS_BASE ADOBE_API_BASE ADOBE_AUTH_BASE CORS_ORIGINS CANCEL_ENABLED CANCEL_DIRECT_ENABLED"
CHAVES_SECRET="CLIENT_ID CLIENT_SECRET SIGNATURE_SECRET LOG_USER LOG_PASS START_AUTH_USER START_AUTH_PASS CANCEL_DIRECT_AUTH_USER CANCEL_DIRECT_AUTH_PASS OTCS_USER OTCS_PASS ADOBE_REFRESH_TOKEN"
OBRIGATORIAS_SECRET="CLIENT_ID CLIENT_SECRET SIGNATURE_SECRET LOG_USER LOG_PASS OTCS_USER OTCS_PASS"
TEM_SECRET=0
if [ -f "$DIR/kustomization.yaml" ] && grep -q -E '^secretGenerator:' "$DIR/kustomization.yaml"; then
  TEM_SECRET=1
fi
NS=""
SC=""
PU=""
IMG=""

# Linhas CHAVE=valor de um env file: sem \r, sem linhas em branco e sem comentários
entradas() { tr -d '\r' < "$1" | grep -v -E '^[[:space:]]*(#|$)'; }
# Números das linhas que não são comentário nem vazias e não começam com CHAVE= no formato dado (só o número sai)
# uso: linhas_invalidas ARQUIVO REGEX_DA_CHAVE
linhas_invalidas() {
  tr -d '\r' < "$1" | grep -n -v -E '^[[:space:]]*(#|$)' | grep -v -E "^[0-9]+:$2=" | cut -d: -f1
}
# Quantas vezes a chave aparece no arquivo: quantas ARQUIVO CHAVE
quantas() { entradas "$1" | grep '=' | cut -d= -f1 | grep -c -x -- "$2"; }
# Valor da primeira ocorrência da chave: valor ARQUIVO CHAVE
valor() { entradas "$1" | grep -E "^$2=" | head -n 1 | cut -d= -f2-; }
# Nome que pode ser exibido (formato de nome). O resto nunca é mostrado
nome_ok() { printf '%s' "$1" | grep -q -E '^[A-Za-z_][A-Za-z0-9_]*$'; }
# Valor que o YAML leria como número, booleano ou nulo (o kustomize o grava sem aspas e o cluster rejeita)
ambiguo() {
  printf '%s' "$1" | grep -q -i -E '^([-+]?[0-9][0-9_]*(\.[0-9_]*)?([eE][-+]?[0-9]+)?|[-+]?\.[0-9_]+([eE][-+]?[0-9]+)?|0x[0-9a-f_]+|0o?[0-7_]+|[-+]?\.(inf|nan)|y|yes|n|no|true|false|on|off|null|~|[0-9]+(:[0-5]?[0-9])+)$'
}
# Valor com aspas no início ou no fim (o kustomize mantém as aspas no valor)
citado() {
  case "$1" in
    \"*|\'*|*\"|*\') return 0 ;;
  esac
  return 1
}
# UTF-8 sem BOM. Não mostra o conteúdo nem os bytes. uso: codificacao_ok ARQUIVO ROTULO
codificacao_ok() {
  if [ "$(head -c 3 "$1" | od -An -tx1 | tr -d ' \n')" = "efbbbf" ]; then
    erro "$2: tiene BOM (marca que agrega Notepad al guardar). Guárdelo como UTF-8 sin BOM"
    return 1
  fi
  if command -v iconv >/dev/null 2>&1; then
    if ! iconv -f UTF-8 -t UTF-8 "$1" >/dev/null 2>&1; then
      erro "$2: no es UTF-8 válido. Guárdelo como UTF-8 sin BOM. El contenido no se muestra"
      return 1
    fi
  else
    aviso "$2: no hay iconv; no se verificó que sea UTF-8"
  fi
  return 0
}
# Par de credenciais: as duas ou nenhuma. uso: par_completo CHAVE_USUARIO CHAVE_SENHA
par_completo() {
  PAR_U=$(valor "$S" "$1")
  PAR_P=$(valor "$S" "$2")
  if [ -n "$PAR_U" ] && [ -z "$PAR_P" ]; then erro "secret.env: $1 tiene valor y $2 está vacío. Complete las dos o ninguna"; fi
  if [ -z "$PAR_U" ] && [ -n "$PAR_P" ]; then erro "secret.env: $2 tiene valor y $1 está vacío. Complete las dos o ninguna"; fi
}
# Confere um campo do render com o valor de params.env, sem mostrar o render (tem Secret em base64).
# uso: conferir CAMPO VALOR_ESPERADO QUANTIDADE
conferir() {
  LINHAS=$(tr -d '\r' < "$TMP/render.txt" | grep -E "^[[:space:]]*$1: " | sed -e "s/^[[:space:]]*$1: //" -e 's/^"\(.*\)"$/\1/')
  TOTAL=$(printf '%s\n' "$LINHAS" | grep -c .)
  IGUAIS=$(printf '%s\n' "$LINHAS" | grep -c -x -F -- "$2")
  if [ "$TOTAL" -ne "$3" ] || [ "$IGUAIS" -ne "$3" ]; then
    erro "render: el campo '$1' no sale igual a params.env (se esperaba $3 vez(es) '$2'; el render tiene $TOTAL con ese campo y $IGUAIS igual(es))"
  fi
}

# ------------------------------------------------------------------ params.env
ANTES=$ERROS
if [ ! -f "$P" ]; then
  erro "falta $P"
  BLOQUEIO=1
else
  codificacao_ok "$P" "params.env" || BLOQUEIO=1
  NS=$(valor "$P" NAMESPACE)
  SC=$(valor "$P" STORAGE_CLASS)
  PU=$(valor "$P" PUBLIC_URL)
  IMG=$(valor "$P" IMAGE)
  INV=$(linhas_invalidas "$P" '[A-Z_][A-Z0-9_]*')
  if [ -n "$INV" ]; then BLOQUEIO=1; fi
  for n in $INV; do
    erro "params.env: línea $n sin formato CLAVE=valor (nombres en mayúsculas, sin espacios; contenido no mostrado)"
  done
  entradas "$P" | grep '=' | cut -d= -f1 > "$TMP/params_chaves"
  while IFS= read -r k; do
    nome_ok "$k" || continue
    case " $CHAVES_PARAMS " in
      *" $k "*) ;;
      *) aviso "params.env: clave desconocida '$k' (el overlay no la usa)" ;;
    esac
  done < "$TMP/params_chaves"

  for k in $CHAVES_PARAMS; do
    n=$(quantas "$P" "$k")
    if [ "$n" -eq 0 ]; then erro "params.env: falta $k"; continue; fi
    if [ "$n" -gt 1 ]; then erro "params.env: $k aparece $n veces"; continue; fi
    v=$(valor "$P" "$k")
    if [ -z "$v" ]; then erro "params.env: $k está vacío"; continue; fi
    case "$v" in
      *'<'*|*'>'*) erro "params.env: $k todavía tiene el modelo '<...>': complete el valor"; continue ;;
    esac
    case "$v" in
      *" "*|*"$TAB"*|*"#"*)
        erro "params.env: $k tiene espacio, tabulación o '#' ('$v'). Los comentarios van en una línea propia, y los valores no admiten espacios"
        continue ;;
    esac
    if citado "$v"; then erro "params.env: $k está entre comillas; kustomize conserva las comillas en el valor. Escriba sin comillas"; continue; fi
    case "$k" in
      CANCEL_*) ;;
      *)
        if ambiguo "$v"; then
          erro "params.env: $k ('$v') lo lee el YAML como número, booleano o nulo, y el cluster lo rechaza. Use un valor con letras"
          continue
        fi ;;
    esac
    case "$k" in
      NAMESPACE)
        if ! printf '%s' "$v" | grep -q -E '^[a-z0-9]([-a-z0-9]*[a-z0-9])?$' || [ "${#v}" -gt 63 ]; then
          erro "params.env: NAMESPACE no válido ('$v'): minúsculas, números y guion, hasta 63 caracteres"
        fi ;;
      PUBLIC_URL)
        if ! printf '%s' "$v" | grep -q -E '^https://[A-Za-z0-9.-]+$'; then
          erro "params.env: PUBLIC_URL debe ser solo el origen, sin ruta ni barra final: https://host ('$v')"
        elif ambiguo "${v#https://}"; then
          erro "params.env: el host de PUBLIC_URL ('$v') lo lee el YAML como número o booleano"
        fi ;;
      IMAGE)
        case "$v" in
          *@sha256:*) ;;
          *)
            ULTIMO=${v##*/}
            case "$ULTIMO" in
              *:*) [ "${ULTIMO##*:}" = latest ] && aviso "params.env: IMAGE usa la etiqueta 'latest'. Prefiera una etiqueta fija (por ejemplo, el hash corto del commit)" ;;
              *) erro "params.env: IMAGE sin etiqueta (tag). Use <registro>/<namespace>/signature-orchestrator:<tag>" ;;
            esac ;;
        esac ;;
      ADOBE_API_BASE|ADOBE_AUTH_BASE)
        if ! printf '%s' "$v" | grep -q -E '^https://[^/]+$'; then
          erro "params.env: $k debe ser https://host, sin ruta ('$v')"
        fi ;;
      OTCS_BASE)
        case "$v" in
          https://*) ;;
          *) erro "params.env: OTCS_BASE debe empezar con https:// ('$v')" ;;
        esac
        case "$v" in
          */) erro "params.env: OTCS_BASE no puede terminar con barra ('$v')" ;;
        esac ;;
      CORS_ORIGINS)
        printf '%s\n' "$v" | tr ',' '\n' > "$TMP/cors"
        while IFS= read -r origem; do
          if ! printf '%s' "$origem" | grep -q -E '^https?://[^/]+$'; then
            erro "params.env: CORS_ORIGINS tiene un elemento no válido ('$origem'). Lista separada por comas; cada elemento https://host"
          fi
        done < "$TMP/cors" ;;
      STORAGE_SIZE)
        if ! printf '%s' "$v" | grep -q -E '^[0-9]+(Mi|Gi|Ti)$'; then
          erro "params.env: STORAGE_SIZE no válido ('$v'). Use un valor como 2Gi"
        fi ;;
      CANCEL_ENABLED|CANCEL_DIRECT_ENABLED)
        if [ "$v" != true ] && [ "$v" != false ]; then
          erro "params.env: $k debe ser true o false ('$v')"
        fi ;;
    esac
  done
  [ "$ERROS" -eq "$ANTES" ] && ok "params.env: claves presentes y con formato esperado"
fi

# ------------------------------------------------------------------ secret.env
ANTES=$ERROS
if [ "$TEM_SECRET" -eq 0 ]; then
  ok "kustomization sin secretGenerator (opción B): el Secret signature-orchestrator-env debe existir en el namespace"
elif [ ! -f "$S" ]; then
  erro "falta $S. Copie el modelo (cp $DIR/secret.env.example $S) y complételo, o use la opción B (README, paso 2.2)"
  BLOQUEIO=1
else
  codificacao_ok "$S" "secret.env" || BLOQUEIO=1
  INV=$(linhas_invalidas "$S" '[A-Za-z_][A-Za-z0-9_]*')
  if [ -n "$INV" ]; then BLOQUEIO=1; fi
  for n in $INV; do
    erro "secret.env: línea $n sin formato CLAVE=valor (contenido no mostrado)"
  done
  # "N:CHAVE" de cada linha com '='. Só o número da linha é exibido: um valor colado sozinho numa linha, no formato
  # Nome123=, seria lido como chave
  tr -d '\r' < "$S" | grep -n -v -E '^[[:space:]]*(#|$)' | grep '=' | cut -d= -f1 > "$TMP/secret_chaves"
  while IFS= read -r l; do
    n=${l%%:*}
    k=${l#*:}
    nome_ok "$k" || continue
    case " $CHAVES_SECRET " in
      *" $k "*) ;;
      *) aviso "secret.env: línea $n con clave desconocida (nombre no mostrado; el overlay no la usa; compare con secret.env.example)" ;;
    esac
  done < "$TMP/secret_chaves"

  for k in $CHAVES_SECRET; do
    n=$(quantas "$S" "$k")
    obrigatoria=0
    case " $OBRIGATORIAS_SECRET " in *" $k "*) obrigatoria=1 ;; esac
    if [ "$n" -gt 1 ]; then erro "secret.env: $k aparece $n veces"; fi
    if [ "$n" -eq 0 ]; then
      if [ "$obrigatoria" -eq 1 ]; then erro "secret.env: falta $k"; fi
      continue
    fi
    v=$(valor "$S" "$k")
    if [ "$obrigatoria" -eq 1 ] && [ -z "$v" ]; then erro "secret.env: $k está vacío (obligatorio)"; fi
    case "$v" in
      *'<'*) erro "secret.env: $k todavía tiene el modelo '<...>': complete el valor"; continue ;;
    esac
    if citado "$v"; then erro "secret.env: $k está entre comillas; kustomize conserva las comillas en el valor. Escriba sin comillas"; fi
  done

  par_completo START_AUTH_USER START_AUTH_PASS
  par_completo CANCEL_DIRECT_AUTH_USER CANCEL_DIRECT_AUTH_PASS
  SU=$(valor "$S" START_AUTH_USER)
  SP=$(valor "$S" START_AUTH_PASS)
  LU=$(valor "$S" LOG_USER)
  LP=$(valor "$S" LOG_PASS)
  if [ -n "$SU" ] && [ "$SU" = "$LU" ]; then aviso "secret.env: START_AUTH_USER es igual a LOG_USER. La credencial del WebReport queda visible en el HTML: use otro valor"; fi
  if [ -n "$SP" ] && [ "$SP" = "$LP" ]; then aviso "secret.env: START_AUTH_PASS es igual a LOG_PASS. La credencial del WebReport queda visible en el HTML: use otro valor"; fi
  if [ -n "$(valor "$S" ADOBE_REFRESH_TOKEN)" ]; then aviso "secret.env: ADOBE_REFRESH_TOKEN tiene valor. Solo se usa si tokens.json no tiene refresh token; lo recomendado es dejarlo vacío y autorizar en /admin/login"; fi

  if git -C "$DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    if git -C "$DIR" ls-files --error-unmatch -- secret.env >/dev/null 2>&1; then
      erro "secret.env está versionado en Git. Quítelo del índice (git rm --cached) y no suba credenciales"
    fi
    if ! git -C "$DIR" check-ignore -q --no-index -- secret.env; then
      erro "secret.env no está ignorado por Git. Revise .gitignore (línea secret.env)"
    fi
  fi
  if [ "$ERROS" -eq "$ANTES" ]; then
    ok "secret.env: claves obligatorias presentes; ningún valor se muestra"
  else
    BLOQUEIO=1
  fi
fi

# ------------------------------------------------------------------ render (oc kustomize)
ANTES=$ERROS
CLI=""
if command -v oc >/dev/null 2>&1; then
  CLI=oc
elif command -v kubectl >/dev/null 2>&1; then
  CLI=kubectl
fi
if [ ! -f "$DIR/kustomization.yaml" ]; then
  erro "falta $DIR/kustomization.yaml"
elif [ "$BLOQUEIO" -eq 1 ]; then
  aviso "render omitido: hay errores de archivo, de formato o de codificación (vea arriba)"
elif [ -z "$CLI" ]; then
  erro "no hay oc ni kubectl en el PATH (se necesitan para renderizar kustomize)"
elif "$CLI" kustomize "$DIR" > "$TMP/render.yaml" 2> "$TMP/render.err"; then
  tr -d '\r' < "$TMP/render.yaml" > "$TMP/render.txt"
  if grep -q 'name: deploy-params' "$TMP/render.txt"; then
    aviso "la salida contiene 'name: deploy-params': kustomize antiguo que no descarta el ConfigMap local-config. No es un error"
  fi
  for tipo in PersistentVolumeClaim ConfigMap Deployment Service Route; do
    n=$(grep -c -x -- "kind: $tipo" "$TMP/render.txt")
    if [ "$n" -ne 1 ]; then erro "render: se esperaba 1 recurso kind: $tipo, se encontraron $n"; fi
  done
  if [ "$TEM_SECRET" -eq 1 ]; then ESPERADO_SECRET=1; else ESPERADO_SECRET=0; fi
  n=$(grep -c -x -- "kind: Secret" "$TMP/render.txt")
  if [ "$n" -ne "$ESPERADO_SECRET" ]; then erro "render: se esperaba $ESPERADO_SECRET recurso kind: Secret, se encontraron $n"; fi
  # Os valores gravados pelo kustomize têm de ser exatamente os de params.env (pega coerções do YAML)
  if [ -n "$NS" ]; then conferir namespace "$NS" $((5 + TEM_SECRET)); fi
  if [ -n "$PU" ]; then conferir host "${PU#https://}" 1; fi
  if [ -n "$SC" ]; then conferir storageClassName "$SC" 1; fi
  if [ -n "$IMG" ]; then conferir image "$IMG" 1; fi
  [ "$ERROS" -eq "$ANTES" ] && ok "render: $CLI kustomize generó los recursos esperados y los valores de params.env coinciden"
else
  erro "$CLI kustomize falló en $DIR."
  if [ "$TEM_SECRET" -eq 1 ]; then
    echo "    Sin detalle: la salida puede repetir líneas de secret.env. Para verla, ejecute a mano: $CLI kustomize $DIR"
  else
    head -n 20 "$TMP/render.err" | sed 's/^/    /'
  fi
fi

# ------------------------------------------------------------------ clúster (solo lectura)
if ! command -v oc >/dev/null 2>&1 || ! oc whoami >/dev/null 2>&1; then
  aviso "sin sesión oc: se omiten las verificaciones del clúster"
elif [ -f "$P" ]; then
  case "$NS" in
    ''|*'<'*) ;;
    *)
      if oc get namespace "$NS" >/dev/null 2>&1 || oc get project "$NS" >/dev/null 2>&1; then
        ok "namespace $NS existe"
      else
        aviso "el namespace $NS no existe o no es visible con esta sesión (oc new-project $NS)"
      fi ;;
  esac

  case "$SC" in
    ''|*'<'*) ;;
    *)
      PROV=$(oc get storageclass "$SC" -o jsonpath='{.provisioner}' 2>/dev/null)
      if [ -z "$PROV" ]; then
        aviso "StorageClass $SC no encontrada o sin permiso para leerla"
      elif printf '%s' "$PROV" | grep -q -i -E 'cephfs|efs\.csi|file\.csi\.azure|nfs'; then
        erro "StorageClass $SC usa $PROV (compartido por red: NFS, CephFS, EFS o SMB); no sirve para el SQLite (README, sección 1.3)"
      elif printf '%s' "$PROV" | grep -q -E 'rbd\.csi\.ceph|ebs\.csi\.aws|disk\.csi\.azure|kubernetes\.io/azure-disk|csi\.vsphere\.vmware|pd\.csi\.storage\.gke'; then
        ok "StorageClass $SC es de bloque ($PROV)"
      else
        aviso "StorageClass $SC tiene el provisioner $PROV, que no figura en la lista: confirme que es de bloque RWO (README, sección 1.4)"
      fi ;;
  esac

  case "$PU" in
    ''|*'<'*) ;;
    *)
      HOST=${PU#https://}
      ROTAS=$(oc get route -A -o jsonpath='{range .items[*]}{.metadata.namespace}/{.metadata.name} {.spec.host}{"\n"}{end}' 2>/dev/null)
      if [ $? -ne 0 ]; then
        aviso "no se pudieron listar las Routes (permisos): no se verifica el host $HOST"
      else
        printf '%s\n' "$ROTAS" | awk -v h="$HOST" -v e="$NS/signature-orchestrator" '$2 == h && $1 != e { print $1 }' > "$TMP/rotas"
        if [ -s "$TMP/rotas" ]; then
          aviso "el host $HOST ya lo usa la Route $(head -n 1 "$TMP/rotas") (HostAlreadyClaimed): la nueva no se admite hasta que la antigua salga (README, paso 2.7)"
        else
          ok "el host $HOST no lo usa otra Route"
        fi
      fi ;;
  esac
fi

echo
if [ "$ERROS" -gt 0 ]; then
  echo "Resultado: $ERROS error(es) y $AVISOS aviso(s). Corrija los ERROR antes de aplicar."
  exit 1
fi
echo "Resultado: sin errores y $AVISOS aviso(s). Listo para aplicar: oc apply -k $DIR"
exit 0
