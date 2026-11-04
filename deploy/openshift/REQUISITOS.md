# Requisitos para desplegar el orquestador de firmas en OpenShift (PROD)

Documento para el equipo de OpenShift. Los detalles técnicos, el backup y la operación están en `deploy/openshift/README.md`, en portugués.

## 1. Qué es

- Un pod con Node.js 22 (imagen UBI 9) que ejecuta el orquestador del flujo de firma electrónica.
- Guarda su estado en SQLite, en un volumen persistente (PVC) de 2 GiB. El volumen contiene datos personales (correos de los firmantes): protéjalo y respáldelo con el mismo cuidado que una base de datos.
- Se expone con una Route HTTPS. Recibe los webhooks de Adobe Sign y las llamadas de los WebReports del Content Server, hechas desde los navegadores de los usuarios.
- Llama a la API de OpenText Content Server (OTCS) y a la API de Adobe Sign.
- Tiene una sola réplica. No se escala horizontalmente.

## 2. Requisitos de la plataforma

| Requisito | Valor | Motivo |
|---|---|---|
| Namespace (proyecto) | El de `NAMESPACE` en `params.env`, creado antes del despliegue | Aislamiento y permisos del despliegue |
| StorageClass | **De bloque, ReadWriteOnce** (ext4 o xfs). Ejemplos: `ocs-storagecluster-ceph-rbd`, `gp3-csi`, `managed-csi`, `thin-csi`, `standard-csi` | SQLite en modo WAL necesita locks de archivo y memoria compartida en el mismo host |
| Nunca | NFS, CephFS, EFS, Azure Files (SMB) ni cualquier clase ReadWriteMany | Son sistemas de archivos de red: no garantizan esos locks, y la base se corrompe o se bloquea |
| Tamaño del PVC | 2Gi (`STORAGE_SIZE`). Conviene que la clase permita expansión (`allowVolumeExpansion: true`) | Logs con retención de 15 días y base SQLite con historial de eventos |
| Réplicas y estrategia | 1 réplica y estrategia `Recreate`. No escalar ni activar HPA | Un único proceso puede usar el volumen |
| SCC | `restricted-v2` (la predeterminada). El Deployment no fija `runAsUser` ni `fsGroup` | El UID y el grupo del volumen los asigna el cluster. No ejecutar como root |
| Recursos | requests: 100m de CPU y 256Mi de RAM; limits: 1 CPU y 512Mi de RAM | Carga esperada del servicio |
| Probes | `GET /health` sin autenticación, desde el kubelet | Verifica que el proceso responde; no consulta OTCS ni Adobe |
| Route | TLS edge con redirección de HTTP a HTTPS; host = `PUBLIC_URL`; timeout de 120 s (ya anotado en el manifiesto) | Adobe Sign y los WebReports llaman por HTTPS. OTCS y Adobe pueden tardar hasta 60 s |
| Entrada (ingress) | Desde Internet: `POST /webhook` (Adobe Sign). Desde los navegadores de los usuarios: `/auth` y `/start` (WebReports) y `/admin`, `/logs` con Basic Auth (equipo de integración) | Son los canales de entrada del servicio |
| Salida (egress) | HTTPS (443) hacia `otcs.g115.opentext.cloud`, `api.na4.adobesign.com` y `secure.na4.adobesign.com` | Llamadas a OTCS y a Adobe Sign |
| Build de la imagen | Egress hacia los hosts de la tabla «Egress del build» | Imagen base, dependencias y binario nativo |
| Registry | Un registry donde publicar la imagen: el interno de OpenShift o uno externo | El Deployment descarga la imagen desde ahí |
| Herramientas | `oc` con kustomize integrado. Se recomienda kustomize v5: probado con oc 4.22 (kustomize v5.7.1) y kubectl 1.36 (kustomize v5.8.1). Con versiones que no descartan `local-config`, se crea un ConfigMap `deploy-params` sin uso, y `check.sh` lo avisa | Render de los manifiestos con `oc apply -k` |

**Egress del build (hosts a permitir):**

| Host | Uso |
|---|---|
| `registry.access.redhat.com` | Imágenes base `ubi9/nodejs-22` y `ubi9/nodejs-22-minimal` (`FROM` del Containerfile) |
| `registry.npmjs.org` | `npm ci`: dependencias de Node |
| `github.com` y `objects.githubusercontent.com` | Binario precompilado de better-sqlite3 (prebuild), descargado de GitHub Releases |
| `nodejs.org` | Solo como camino de respaldo, si no hay prebuild: cabeceras de Node para compilar better-sqlite3 con node-gyp (además, python3, make y g++ en la imagen de build) |

## 3. Qué se entrega y qué completa cada equipo

Valores no secretos, en `deploy/openshift/prod/params.env`:

| Clave | Qué es | Quién la completa |
|---|---|---|
| `NAMESPACE` | Namespace del despliegue | Equipo OpenShift |
| `IMAGE` | Referencia de la imagen construida y publicada | Equipo OpenShift, con el build del repositorio |
| `STORAGE_CLASS` | StorageClass de bloque RWO | Equipo OpenShift |
| `STORAGE_SIZE` | Tamaño del PVC (2Gi) | Ya definido |
| `PUBLIC_URL` | Origen público (`https://host`) | Ya definido. Cambiarlo exige coordinar el paso 5 |
| `OTCS_BASE`, `CORS_ORIGINS`, `ADOBE_API_BASE`, `ADOBE_AUTH_BASE` | Endpoints de OTCS y de Adobe Sign (región NA4) | Ya definidos |
| `CANCEL_ENABLED`, `CANCEL_DIRECT_ENABLED` | Cancelación de flujos | Ya definidos en `false` |

Secretos, en `deploy/openshift/prod/secret.env` (plantilla: `secret.env.example`):

| Clave | Uso |
|---|---|
| `CLIENT_ID`, `CLIENT_SECRET` | Aplicación de Adobe Sign |
| `SIGNATURE_SECRET` | Clave HMAC compartida con el WebReport (valida `/start`) |
| `LOG_USER`, `LOG_PASS` | Basic Auth de `/admin` y `/logs` |
| `START_AUTH_USER`, `START_AUTH_PASS` | Opcional, las dos o ninguna: Basic Auth del `POST /auth` |
| `CANCEL_DIRECT_AUTH_USER`, `CANCEL_DIRECT_AUTH_PASS` | Opcional, las dos o ninguna: Basic Auth del modo directo de cancelación. Sin ellas vale la del `/auth` |
| `OTCS_USER`, `OTCS_PASS` | Usuario de integración en OTCS |
| `ADOBE_REFRESH_TOKEN` | Opcional. Debe quedar vacío: la autorización se hace en `/admin/login` |

El responsable de la integración entrega los valores por un canal seguro. No se envían por correo ni por chat en texto claro, y nunca se suben al repositorio.

**Opción B.** Si el equipo prefiere gestionar los secretos con Vault, External Secrets u otro mecanismo, cree el Secret `signature-orchestrator-env` con las claves de la tabla y quite el bloque `secretGenerator` de `prod/kustomization.yaml`.

## 4. Pasos de despliegue

1. Cree o seleccione el proyecto: `oc new-project <namespace>` (o `oc project <namespace>`).
2. Construya y publique la imagen desde la raíz del repositorio:

   ```bash
   podman build -f deploy/openshift/Containerfile -t <registry>/<namespace>/signature-orchestrator:<tag> .
   podman push <registry>/<namespace>/signature-orchestrator:<tag>
   ```

   Etiqueta sugerida: el hash corto del commit (`git rev-parse --short HEAD`). No use `latest`.
3. Edite `deploy/openshift/prod/params.env` y complete `NAMESPACE`, `IMAGE` y `STORAGE_CLASS`.
4. Cree el archivo de secretos: `cp deploy/openshift/prod/secret.env.example deploy/openshift/prod/secret.env`, y complete los valores que entrega el responsable de la integración.
5. Verifique: `sh deploy/openshift/check.sh`. Debe terminar sin ERROR.
6. Aplique: `oc apply -k deploy/openshift/prod`.
7. Verifique el despliegue (todos los comandos apuntan al namespace con `-n`):

   ```bash
   oc get pvc signature-orchestrator-data -n <namespace>          # STATUS Bound; ACCESS MODES RWO
   oc rollout status deploy/signature-orchestrator -n <namespace>
   oc logs deploy/signature-orchestrator -n <namespace> | grep -E "SQLite ready|Server started"
   oc logs deploy/signature-orchestrator -n <namespace> | grep "\[STORAGE\]"   # no debe mostrar líneas
   oc get route signature-orchestrator -n <namespace>             # HOST presente; sin HostAlreadyClaimed
   curl -s <PUBLIC_URL>/health                                    # {"status":"ok"}
   ```

   Esperado: `SQLite ready: /data/state/orchestrator.db (schema vN)` y `Server started successfully`.

## 5. Coordinación con el equipo de integración

El host público y los acuerdos en curso ya pertenecen al orquestador anterior. El equipo de OpenShift no puede resolver estos puntos solo:

1. **Route anterior.** Con el mismo host, la Route nueva queda con `HostAlreadyClaimed`. En la ventana de cambio hay que retirar la Route anterior (antes, guarde su YAML con `oc get route <nombre> -o yaml`) y detener el Deployment anterior, para que solo un orquestador reciba webhooks y `/start`. Rollback: recrear la Route anterior desde el YAML guardado.
2. **Adobe Sign y WebReports.** Con el mismo host siguen valiendo el webhook `<PUBLIC_URL>/webhook` y el `SERVER_URL` de los WebReports. El responsable de la integración debe registrar `<PUBLIC_URL>/admin/callback` como redirect URI en la aplicación de Adobe, y autorizar en `<PUBLIC_URL>/admin/login`.
3. **Acuerdos en curso.** La base nueva empieza vacía. Hay que decidir si se importa el mapa de acuerdos del servicio anterior o si cada caso se trata por adopción manual (README, paso 2.7). Sin esa decisión, los acuerdos en curso no se cierran.

## 6. Lo que no se debe hacer

- Subir las réplicas ni activar autoescalado: el volumen SQLite no admite dos procesos.
- Usar una StorageClass NFS, CephFS, EFS, Azure Files o ReadWriteMany.
- Aplicar con `oc apply -f` sobre las carpetas de `deploy/openshift/`. Los valores de `params.env` y el Secret solo se generan con `oc apply -k`.
- Subir `secret.env` al repositorio, ni pegar credenciales en tickets o chats.
- Cambiar la SCC o ejecutar el contenedor como root.
- Cambiar `PUBLIC_URL` sin coordinar el paso 5.

## 7. Actualización

- **Nueva imagen:** construya y publique con la nueva etiqueta, cambie `IMAGE` en `params.env`, ejecute `check.sh` y luego `oc apply -k deploy/openshift/prod`. La estrategia `Recreate` deja el servicio caído unos segundos.
- **Cambio en `secret.env`:** `oc apply -k` crea un Secret nuevo (con sufijo de hash) y el Deployment se reinicia solo.
- **Cambio en `params.env` o en `base/configmap.yaml`:** `oc apply -k` y después `oc rollout restart deploy/signature-orchestrator -n <namespace>`. El pod no vuelve a leer las variables por sí solo.
- **Secret creado a mano en un despliegue anterior** (`signature-orchestrator-env`, sin hash): después del primer `oc apply -k` queda sin uso. Si el orquestador anterior está en el mismo namespace y lo usa, no lo borre hasta retirar ese servicio. En otro caso, puede borrarse cuando el rollout termine bien.
- **Secrets antiguos:** cada cambio de `secret.env` crea un Secret `signature-orchestrator-env-<hash>`. No los borre a ciegas: `oc rollout undo` vuelve a un ReplicaSet anterior que usa su propio Secret, y `revisionHistoryLimit: 5` conserva cinco ReplicaSets. Antes de borrar, liste los Secrets que siguen referenciados (solo lectura):

  ```bash
  oc get rs -n <namespace> -l app=signature-orchestrator -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.spec.template.spec.containers[0].envFrom[*].secretRef.name}{"\n"}{end}'
  oc get secret -n <namespace> -o name | grep 'signature-orchestrator-env-'
  ```

  Solo borre un `signature-orchestrator-env-<hash>` que no aparezca en la primera lista.
- **Antes de actualizar con migración de base de datos:** haga el respaldo (README, sección 1.8). El log de arranque muestra `schema vN`; compárelo con la versión anterior.
- **Rollback:** `oc rollout undo deploy/signature-orchestrator -n <namespace>` vuelve a la réplica anterior (imagen y configuración del pod). En la opción A, el Secret de esa réplica vuelve junto, siempre que todavía exista; por eso la limpieza no borra lo referenciado. El ConfigMap no está versionado: el rollback usa su contenido actual. El rollback no deshace migraciones de base de datos: haga el respaldo antes.

Detalles de operación, respaldo y restauración: `deploy/openshift/README.md`, en portugués.
