---
title: ChatGPT 데스크톱 전송 잠금 해제
description: 계정 사용량 한도가 소진되어도 ChatGPT 데스크톱 앱의 입력창을 계속 쓸 수 있게 합니다(macOS, 옵트인).
---

로그인한 ChatGPT 계정의 사용량 한도가 소진되면 ChatGPT 데스크톱 앱은 전송 버튼을 비활성화합니다.
그 대화의 모델 호출을 opencodex가 다른 프로바이더로 라우팅하는 경우에도 마찬가지입니다. 이 옵트인
macOS 통합은 입력창을 계속 쓸 수 있게 합니다. 기본값은 꺼짐입니다.

## 바뀌는 것

opencodex는 `chatgpt.com`용 로컬 TLS 리스너를 실행합니다. 앱은 `chatgpt.com`을 이 리스너로 보내는
Chromium 스위치와 함께 실행되며, 서브도메인을 포함한 다른 모든 호스트는 평소 경로를 유지합니다.
요청은 앱 자신의 자격 증명으로 실제 `chatgpt.com`에 중계되고, WebSocket(음성 받아쓰기 등)도
중계됩니다. 아무것도 기록하거나 저장하지 않습니다.

응답은 다음 두 엔드포인트를 제외하고 그대로 전달됩니다.

- 대화 메타데이터(`/backend-api/conversation/init`와 대화 스트림): 사용량 한도로 인한 전송 잠금을 제거합니다.
- 사용량 스냅샷(`/backend-api/wham/usage`): "한도 도달" 게이트를 엽니다.

구독 필요 등 다른 이유의 전송 잠금은 그대로 두며 `ocx chatgpt status`에 표시됩니다. 표시되는
사용량(비율, 초기화 시각, 배너)은 바뀌지 않으며, OpenAI 서버는 자체 요청에 모든 한도를 계속 적용합니다.

일부 빌드에서는 전송 버튼이 앱에 내장된 Codex 서버가 계정에 대해 보고하는 내용을 따릅니다. 이 서버는
자체 HTTP 클라이언트로 그 정보를 가져오므로 리졸버 규칙도 PAC 파일도 닿지 않습니다. 이 경우는
아래에서 설명하는 실험적 app-server 심이 다룹니다.

## 설정

1. `~/.opencodex/config.json`에서 기능을 켜고 opencodex를 다시 시작합니다.

   ```json
   { "chatgptDesktop": { "unblockSend": true } }
   ```

   리스너는 프록시 포트에 200을 더한 포트(기본 `10300`)를 씁니다. 다른 포트를 쓰려면
   `chatgptDesktop.port`를 설정합니다.

2. 로컬 인증 기관을 한 번만 신뢰합니다. 이 명령은 로그인 암호를 묻기 때문에 직접 실행하세요.

   ```bash
   security add-trusted-cert -r trustRoot -p ssl \
     -k ~/Library/Keychains/login.keychain-db ~/.opencodex/claude-intercept/ca.pem
   ```

   이 신뢰가 없으면 앱이 계정, 사용량, 설정 페이지를 불러오지 못합니다. opencodex 홈을 바꿔 쓰는
   경우 `ocx chatgpt status`가 환경에 맞는 정확한 명령을 출력합니다.

3. opencodex를 통해 앱을 실행합니다.

   ```bash
   ocx chatgpt launch
   ```

4. 선택: Dock과 Spotlight에서 평소처럼 실행해도 경로를 쓰게 합니다.

   ```bash
   ocx chatgpt install-watcher
   ```

   감시자는 앱이 시작될 때마다, 그리고 opencodex가 시작될 때도 동작합니다. 앱이 평소 방식으로 열리면
   실행 직후 앱을 종료하고 경로와 함께 다시 엽니다. 로그인 시 앱이 opencodex보다 먼저 열리면
   opencodex가 실행되는 즉시 이 작업을 합니다. 한동안 사용한 앱을 종료하지 않도록 최근 5분 이내에
   시작된 앱만 다시 시작합니다(앱의 실행 시간을 읽을 수 없으면 방금 시작된 것으로 봅니다).
   `ocx chatgpt launch`는 실행 시간과 관계없이 다시 시작합니다. opencodex가 실행 중이 아닐 때는
   아무것도 하지 않습니다. 이 명령은 확인을 요청하며, `--yes`로 비대화식으로 확인할 수 있습니다.

## 네트워크 환경

VPN이나 프록시 규칙을 설정할 필요가 없습니다. 기본 모드에서는 실행 인자가 앱이 시작될 때마다 시스템
프록시에 따라 정해집니다.

| 환경 | 앱 실행 인자 |
|---|---|
| 프록시 없음 | `chatgpt.com` 경로만. |
| 시스템 프록시 모드 VPN | 경로, 직접 연결 폴백이 있는 시스템 프록시, `chatgpt.com`만 우회. |
| TUN 모드 VPN | 경로만. 루프백 트래픽은 터널에 들어가지 않습니다. |
| PAC 파일 | 경로만. PAC 파일이 `chatgpt.com`을 프록시에 남길 수 있어 입력창이 잠긴 채로 있을 수 있지만, 다른 기능은 망가지지 않습니다. |

opencodex는 다른 외부 트래픽과 마찬가지로 자체 `proxy` 설정으로 실제 `chatgpt.com`에 접속합니다.

## opencodex를 멈춰도 앱 계속 쓰기

기본 모드에서는 경로가 적용된 앱이 리스너에 의존합니다. opencodex가 멈춰 있는 동안 `chatgpt.com`
요청은 실패합니다. PAC 폴백은 대신 생성된 PAC 파일로 앱을 실행하므로, 앱이 스스로 폴백합니다.

```json
{ "chatgptDesktop": { "unblockSend": true, "pacFallback": true } }
```

`pacFallback`은 `unblockSend`와 함께일 때만 적용됩니다. 이때 opencodex는 리스너 포트 + 1(기본값
`10301`)에서도 대기하고, 시작할 때마다 홈 디렉터리의 `chatgpt-unblock.pac`을 다시 씁니다. PAC는
`chatgpt.com`을 먼저 opencodex로 보내고, 다른 호스트는 시스템 경로대로 보냅니다.

| 환경 | 다른 호스트, 그리고 opencodex가 멈춘 동안의 `chatgpt.com` |
|---|---|
| 프록시 없음 또는 TUN 모드 VPN | 직접 연결. |
| 시스템 프록시 모드 VPN | 시스템 프록시, 그다음 직접 연결. |
| PAC 파일 | 시스템 PAC(생성된 파일에 포함). |

opencodex가 멈춰도 앱은 재시작 없이 이 경로로 계속 동작하며, 보내기 잠금 해제만 opencodex가 돌아올
때까지 멈춥니다. 경로는 opencodex가 시작될 때 가져옵니다. VPN 모드를 바꾼 뒤에는 opencodex를 다시
시작하고 `ocx chatgpt launch`를 실행하세요. 그 시점에 시스템 PAC가 설정되어 있지만 읽을 수 없거나 앱에
넘기기에 너무 크면(PAC는 실행 인수 하나에 담겨 전달되며, 인코딩 후 512KiB로 제한됩니다) 다른 호스트는
시스템 프록시가 있으면 그것을 거친 뒤 직접 연결되고 opencodex가 경고를 출력합니다.

`pacFallback`을 켜거나 끈 뒤에는 opencodex를 다시 시작하고 `ocx chatgpt launch`를 실행하며, 감시자를
쓰고 있다면 `ocx chatgpt install-watcher`도 다시 실행하세요.

## app-server 심(실험적)

심은 내장 Codex 서버의 JSON-RPC 출력을 걸러 알려진 일반 사용량 한도 잠금만 엽니다. 계정의 사용량을
늘리거나, 상위 서비스가 거부하는 요청을 받아들이게 하지는 않습니다. macOS 전용이며 기본적으로 꺼져
있고, 두 가지 방식으로 쓸 수 있습니다.

- **단독으로 쓰기.** `{ "chatgptDesktop": { "appServerShim": true } }`를 설정하고
  `ocx chatgpt launch`를 실행하세요. opencodex는 홈 디렉터리에 실행 가능한 런처를 쓰고, ChatGPT가
  실행 중이면 종료한 뒤 `open -a <bundle> --env CODEX_CLI_PATH=<launcher>`로 다시 실행합니다. 앱은
  번들 식별자 `com.openai.codex`로 찾으므로 `~/Applications`나 다른 볼륨에 설치해도 동작하며, 같은
  "ChatGPT" 이름을 가진 다른 앱을 종료하거나 열지 않습니다. 앱이 다시 시작되므로 작업 중인 내용은
  먼저 저장하세요. opencodex 프록시가 실행 중일 필요는 없습니다. Dock이나 Spotlight에서 평소처럼
  실행하면 심이 적용되지 않습니다. `ocx chatgpt restore`는 런처를 지우고 환경 변수 없이 다시
  실행합니다.
- **전송 차단 해제와 함께 쓰기.** `unblockSend`와 `appServerShim`을 모두 켜면 opencodex가 시작할
  때마다 런처를 준비하고, `ocx chatgpt launch`와 watcher가 그 런처를 거쳐 앱을 시작합니다. 아래
  검사에서 번들이 거부되면 opencodex가 경고를 출력하고, 가로채기는 심 없이 계속 동작합니다.

`account/rateLimits/updated` 알림과, 최상위 결과에 `rateLimits`, `rateLimitsByLimitId`,
`ordinaryUsageAllowed` 중 하나가 들어 있는 응답만 대상입니다. 일반 사용량 한도의 `rate_limit_reached`
표시는 지워지고, 게이트 플래그(`allowed`, `limit_reached` / `limitReached`, `ordinaryUsageAllowed`)는
그 표시나 100%에 이른 창이라는 일반 사용량 한도의 증거가 있을 때만 열립니다. 응답에 이유가 드러나지
않는 플래그는 닫힌 채로 남고, 워크스페이스, 크레딧, 알 수 없는 이유, 지출 제한으로 인한 잠금도 닫힌
채로 유지됩니다. 표시되는 사용량은 받은 그대로이며, 나머지 메시지는 바이트 단위로 그대로 전달됩니다.
표준 입력, 표준 오류, 실제 바이너리의 종료 코드는 앱과 직접 연결된 채로 남습니다.

런처를 쓰기 전에 opencodex는 번들과 그 app-server 바이너리가 사용자 본인이나 root 소유인지, 그룹이나
다른 사용자가 쓸 수 없는지, OpenAI 팀 ID(`2DC432GLL2`)로 엄격한 코드 서명 검증을 통과하는지
확인합니다. 하나라도 실패한 번들은 거부됩니다. 런처의 모드는 `0755`이고, 현재 opencodex 실행 파일을
포함하며, 임시 파일에 쓴 뒤 이름을 바꿔 넣으므로 그 경로의 심볼릭 링크는 따라가지 않고 교체됩니다.
런처와 그 디렉터리, opencodex 설치 위치는 직접 관리하세요. 이 경로들을 바꾸면 앱이 실행하는 코드가
바뀝니다.

macOS가 아니거나, opencodex 실행 환경이 없거나, 필터의 자체 테스트가 실패하면 런처는 원래 바이너리를
출력을 건드리지 않고 실행합니다. 앱 업데이트로 app-server 바이너리 자체가 옮겨지거나 지워지면 런처는
`ocx chatgpt launch`와 `ocx chatgpt restore`를 안내하는 메시지를 출력하고 종료하며, 둘 중 하나를
실행할 때까지 앱은 서버를 시작할 수 없습니다. 자체 테스트를 통과한 필터가 세션 중간에 멈추면 서버의
출력 파이프가 닫히며, 그 뒤 앱의 동작은 검증되지 않았습니다. 8MiB를 넘는 한 줄 출력은 분석하지 않고
그대로 전달합니다. 심은 앱이 `CODEX_CLI_PATH`를 따르는 것과 현재 메시지 형식에 의존하므로, 업데이트로
달라질 수 있습니다.

## 상태 확인

```bash
ocx chatgpt status
```

기능이 켜져 있는지, 포트의 리스너가 opencodex 것인지, 인증서가 신뢰되는지, 감시자 상태, 실행 중인
앱이 경로를 갖고 있는지, 의도적으로 남긴 전송 잠금을 보고합니다. app-server 심이 켜져 있으면 런처가
있는지, 실행 중인 앱이 그 런처를 거쳐 시작되었는지도 보여 줍니다.

## 끄기

```bash
ocx chatgpt uninstall-watcher
ocx chatgpt restore
```

`restore`는 경로가 적용된 앱을 기본 네트워크로 다시 엽니다. 그런 다음 `chatgptDesktop.unblockSend`를
`false`로 설정하고 opencodex를 다시 시작합니다. 인증 기관은 opencodex의 Claude 통합과 공유되므로, 둘
다 쓰지 않을 때만 신뢰를 제거하세요. `restore`는 app-server 심 없이 다시 실행하고 그 런처도 지웁니다.
`appServerShim`도 `false`로 바꾸세요.

## 문제 해결

- **계정, 사용량, 설정 페이지가 로드되지 않음:** 인증서가 신뢰되지 않았습니다. 2단계를 다시
  실행하세요. `ocx chatgpt status`가 신뢰 상태를 보여 줍니다.
- **전송 버튼이 여전히 회색:** `ocx chatgpt status`를 확인하세요. 앱이 경로 없이 실행 중이거나
  (`ocx chatgpt launch` 실행), 잠금 이유가 사용량 한도가 아니어서 "send blocks kept"에 표시될 수 있습니다.
- **경로는 동작하는데 전송 버튼이 여전히 회색:** 잠금이 경로가 다루는 페이지가 아니라 내장 Codex
  서버에서 올 수 있습니다. `chatgptDesktop.appServerShim`을 켜고 `ocx chatgpt launch`를 실행한 뒤
  `ocx chatgpt status`를 확인하세요("app-server shim" 줄이 실행 중인 앱이 심을 거쳐 시작되었는지 알려
  줍니다). opencodex가 시작할 때 심을 준비하지 못했다고 경고했거나 `launch`가 거부했다면, 메시지에
  번들이 통과하지 못한 검사가 나옵니다.
- **opencodex를 멈추면 앱이 아무것도 불러오지 못함:** 기본 모드에서는 경로가 적용된 앱이 리스너에
  의존합니다. opencodex를 다시 시작하거나 `ocx chatgpt restore`를 실행하세요. PAC 폴백을 켜면 앱이
  스스로 폴백합니다.
