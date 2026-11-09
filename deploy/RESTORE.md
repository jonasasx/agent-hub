# Восстановление базы Agent Hub из дампа

Копии делает `deploy/backup.sh` (ежедневно 03:20 UTC, см. «Резервные копии» в `deploy/README.md`): `pg_dump -Fc` баз `agenthub` и `keycloak`, имена `agenthub-<YYYYMMDDTHHMMSSZ>.dump`, `keycloak-…`. Где лежат:

- на ВМ хаба — `/home/ubuntu/agent-hub-backups/`, 14 дней;
- в S3 — `s3://agent-hub-backups-example/pg/`, 30 дней (прежние версии — 7). Ключ хаба читать бакет не может: скачивание — учёткой администратора AWS.

Порядок: сначала проверить дамп на временном стенде (шаг 2), только потом трогать рабочую базу (шаг 3).

## 1. Дамп за дату

```bash
ls -l /home/ubuntu/agent-hub-backups/ | grep -E '(agenthub|keycloak)-2026'
DUMP=/home/ubuntu/agent-hub-backups/agenthub-<stamp>.dump
docker exec -i agent-hub-db-1 pg_restore --list <"$DUMP" | head   # архив читается, в нём есть записи
```

Если на ВМ дампа уже нет — из S3, на машине с учёткой администратора, затем на ВМ:

```bash
aws s3 ls s3://agent-hub-backups-example/pg/ | grep <YYYYMMDD>
aws s3 cp s3://agent-hub-backups-example/pg/agenthub-<stamp>.dump .
scp agenthub-<stamp>.dump ubuntu@<ВМ>:/home/ubuntu/agent-hub-backups/
```

## 2. Проверка на временном стенде

Рабочие контейнеры и базу не трогает: отдельная сеть, отдельный `postgres:17`, хаб без портов наружу. Стенду не давать настоящих `SUBSCRIPTION_TOKEN_KEY`, `AWS_*`, `S3_BUCKET_DATA`, `TELEGRAM_*`, VAPID и OIDC: с ключом он мог бы обновить OAuth-токены и испортить их рабочим сессиям, с остальным — слать уведомления и писать в бакет. Без `S3_BUCKET_DATA` хаб стартует только с `NODE_ENV=development` (это единственное, что меняет переменная).

```bash
PW=$(openssl rand -hex 16)
docker network create ah-restore-net
docker run -d --name ah-restore-db --network ah-restore-net --memory 2g --memory-swap 2g -e POSTGRES_PASSWORD="$PW" postgres:17 \
  postgres -c default_toast_compression=lz4
# образ один раз перезапускает postgres после инициализации: подождать и проверить ещё раз
until docker exec ah-restore-db pg_isready -U postgres -q; do sleep 1; done; sleep 3
until docker exec ah-restore-db pg_isready -U postgres -q; do sleep 1; done
docker exec ah-restore-db createdb -U postgres agenthub
time docker exec -i ah-restore-db pg_restore -U postgres -d agenthub --no-owner --no-privileges --exit-on-error <"$DUMP"

# счётчики: на стенде — на момент дампа; в рабочей базе (только чтение) — строки до времени дампа (stamp из имени файла)
CUT='<YYYY-MM-DD HH:MM:SS>+00'
for tc in sessions:created_at events:ts blobs:created_at subagent_runs:started_at users:created_at catalog_projects:created_at; do
  t=${tc%%:*}
  c=${tc#*:}
  r=$(docker exec ah-restore-db psql -U postgres -d agenthub -Atc "select count(*) from $t")
  p=$(docker exec agent-hub-db-1 sh -c "psql -U \$POSTGRES_USER -d agenthub -Atc \"select count(*) from $t where $c < '$CUT'\"")
  echo "$t restored=$r prod_before_dump=$p"
done

# хаб на восстановленной базе: стартует, /healthz отвечает, каталог проектов загружен
docker run -d --name ah-restore-hub --network ah-restore-net --memory 768m -e PORT=8080 -e NODE_ENV=development \
  -e PUBLIC_URL=http://localhost:8080 -e COOKIE_SECRET="$(openssl rand -hex 32)" -e OIDC_ALLOWED_EMAILS=restore-test@example.invalid \
  -e OIDC_GOOGLE_CLIENT_ID=restore-test -e OIDC_GOOGLE_CLIENT_SECRET=restore-test \
  -e DATABASE_URL="postgres://postgres:$PW@ah-restore-db:5432/agenthub" agent-hub-hub:latest
for i in $(seq 30); do docker exec ah-restore-hub node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>r.text()).then(console.log)" && break; sleep 2; done
docker logs ah-restore-hub 2>&1 | grep -E 'catalogue loaded|listening'

# убрать стенд
docker rm -f ah-restore-hub ah-restore-db && docker network rm ah-restore-net
```

Проверка 2026-11-08, дамп `agenthub-20261108T032224Z.dump` (373 МиБ): `pg_restore` — 191 с, база на стенде — 2165 МБ, последняя миграция `050_mcp_hub_only` (как в рабочей). Счётчики совпали со строками рабочей базы до 03:22:24: `sessions` 4491, `blobs` 22279, `subagent_runs` 1778, `peer_messages` 722, `users` 5, `catalog_projects` 47, `mcp_registry_servers` 34, `runners` 11; `events` 1060596 против 1060595 (одна строка с `ts` на границе дампа). Хаб стартовал за 3 с без новых миграций, `{"ok":true}`, каталог — 53 проекта. Стенд берёт до 2 ГиБ памяти, рабочие сервисы ВМ это выдерживают.

## 3. Возврат в рабочую базу

Только после шага 2. Блок выполняется подшеллом с `set -euo pipefail`: первая ошибка его останавливает, и до удаления базы проверены и дамп, и страховочная копия текущего состояния (путь копии печатается — по нему откат).

```bash
(
  set -euo pipefail
  umask 077
  cd /home/ubuntu/agent-hub
  dc() { if docker compose version >/dev/null 2>&1; then docker compose --env-file .env -f deploy/compose.yml "$@"; else docker-compose --env-file .env -f deploy/compose.yml "$@"; fi; }
  DUMP=/home/ubuntu/agent-hub-backups/agenthub-<stamp>.dump
  docker exec -i agent-hub-db-1 pg_restore --list <"$DUMP" | grep -c '^[0-9]*;'
  dc stop hub
  PRE=/home/ubuntu/agent-hub-backups/pre-restore-agenthub-$(date -u +%Y%m%dT%H%M%SZ).dump
  docker exec agent-hub-db-1 sh -c 'pg_dump -Fc -U "$POSTGRES_USER" -d agenthub' >"$PRE"
  docker exec -i agent-hub-db-1 pg_restore --list <"$PRE" | grep -c '^[0-9]*;'
  echo "rollback copy: $PRE"
  docker exec agent-hub-db-1 sh -c 'dropdb -U "$POSTGRES_USER" --force agenthub && createdb -U "$POSTGRES_USER" agenthub'
  docker exec -i agent-hub-db-1 sh -c 'pg_restore -U "$POSTGRES_USER" -d agenthub --no-owner --exit-on-error' <"$DUMP"
  dc up -d hub
  for i in $(seq 60); do curl -fsS http://$HUB_BIND_ADDR:8090/healthz && break; sleep 2; done
)
```

Откат — тот же блок с `DUMP=<rollback copy>`. Схема в дампе — на момент дампа; если с тех пор вышли миграции, хаб применит их при старте. Образ хаба старше дампа (откат версии) с более новой схемой не работает: сначала вернуть образ того же или более нового коммита.

База `keycloak` (вход пользователей) — так же, со страховочной копией:

```bash
(
  set -euo pipefail
  umask 077
  cd /home/ubuntu/agent-hub
  dc() { if docker compose version >/dev/null 2>&1; then docker compose --env-file .env -f deploy/compose.yml "$@"; else docker-compose --env-file .env -f deploy/compose.yml "$@"; fi; }
  DUMP=/home/ubuntu/agent-hub-backups/keycloak-<stamp>.dump
  docker exec -i agent-hub-db-1 pg_restore --list <"$DUMP" | grep -c '^[0-9]*;'
  dc stop keycloak
  PRE=/home/ubuntu/agent-hub-backups/pre-restore-keycloak-$(date -u +%Y%m%dT%H%M%SZ).dump
  docker exec agent-hub-db-1 sh -c 'pg_dump -Fc -U "$POSTGRES_USER" -d keycloak' >"$PRE"
  docker exec -i agent-hub-db-1 pg_restore --list <"$PRE" | grep -c '^[0-9]*;'
  echo "rollback copy: $PRE"
  docker exec agent-hub-db-1 sh -c 'dropdb -U "$POSTGRES_USER" --force keycloak && createdb -U "$POSTGRES_USER" -O keycloak keycloak'
  docker exec -i agent-hub-db-1 sh -c 'pg_restore -U "$POSTGRES_USER" -d keycloak --no-owner --role=keycloak --exit-on-error' <"$DUMP"
  dc up -d keycloak
)
```

После восстановления агенты переподключатся сами. Всё, что хаб записал после времени дампа, в базе потеряно (транскрипты на машинах остаются).
