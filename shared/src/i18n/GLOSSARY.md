# Glossary

Terms of the product for the translators of `messages/<locale>/`. The source is `en`, `ru` gives the context. Keep the
`{placeholders}` and the plural categories of the language (`Intl.PluralRules`): `ja`, `ko`, `zh-CN` have only `other`.

## Not translated

Claude, Claude Code, Codex, Anthropic, OpenAI, MCP, OAuth, PDF, Markdown, Haiku, Sonnet, Opus, Agent Hub, Git, URL, JSON,
`cwd`, tool and command names (`Bash`, `Monitor`, `TaskStop`), keyboard keys (Enter, Esc, Ctrl).

## Terms

| en | ru | Meaning | de | fr | es | pt-BR | ja | ko | zh-CN |
|---|---|---|---|---|---|---|---|---|---|
| session | сессия | one conversation with an agent | Sitzung | session | sesión | sessão | セッション | 세션 | 会话 |
| machine | машина | a computer where the agent runs | Rechner | machine | máquina | máquina | マシン | 머신 | 机器 |
| agent | агент | the program on a machine that runs sessions | Agent | agent | agente | agente | エージェント | 에이전트 | 代理 |
| hub | хаб | the server everything connects to | Hub | hub | hub | hub | ハブ | 허브 | 中枢 |
| subscription | подписка | a Claude or Codex account plan | Abonnement | abonnement | suscripción | assinatura | サブスクリプション | 구독 | 订阅 |
| limit | лимит | usage window of a subscription | Limit | limite | límite | limite | 上限 | 한도 | 额度 |
| fork | форк | a new session from a point of another | Fork | fork | bifurcación | fork | フォーク | 포크 | 分叉 |
| resume | возобновить | continue a sleeping session | fortsetzen | reprendre | reanudar | retomar | 再開 | 재개 | 恢复 |
| asleep | спит | the process is stopped, the session can resume | schläft | en veille | en reposo | em repouso | スリープ中 | 절전 중 | 休眠中 |
| project | проект | a group of sessions | Projekt | projet | proyecto | projeto | プロジェクト | 프로젝트 | 项目 |
| subagent | субагент | a session started by another session | Subagent | sous-agent | subagente | subagente | サブエージェント | 하위 에이전트 | 子代理 |
| permission request | запрос разрешения | the agent asks to run a tool | Berechtigungsanfrage | demande d'autorisation | solicitud de permiso | pedido de permissão | 許可リクエスト | 권한 요청 | 权限请求 |
| tool window | служебное окно | a side panel: Sessions, Files, Machines, Subscriptions | Werkzeugfenster | fenêtre d'outils | ventana de herramientas | janela de ferramentas | ツールウィンドウ | 도구 창 | 工具窗口 |
| feed | лента | the messages of a session | Verlauf | fil | historial | histórico | タイムライン | 피드 | 消息流 |
| sign in | войти | | anmelden | se connecter | iniciar sesión | entrar | サインイン | 로그인 | 登录 |
| invite | приглашение | | Einladung | invitation | invitación | convite | 招待 | 초대 | 邀请 |

## Style

- Interface tone: short, neutral, imperative buttons («Save», «Speichern», «保存»).
- `de`, `fr`: formal address (Sie, vous). `ja`: です/ます in sentences, nouns on buttons. `ko`: 합니다/하세요 style.
- `es`: neutral Spanish, `tú` form. `pt-BR`: Brazilian Portuguese, `você`.
- Do not shorten a translation to fit a button: the layout truncates with an ellipsis and a tooltip.
