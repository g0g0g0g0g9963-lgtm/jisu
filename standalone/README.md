# 단독 사이트 빌드 (standalone)

실행 프로그램이나 서버 없이, **주소만 열면 바로 보이는 사이트**로 만들기 위한 빌드입니다.

`app/page.tsx`는 브라우저에서만 동작하는 화면(서버 기능 없음)이라, 코드·스타일·로고를 전부 하나의
HTML 페이지 파일로 묶을 수 있습니다.

## 사용 중인 주소

https://claude.ai/code/artifact/386d9d9e-0f1d-4627-96b4-cb0a3c3fcc8a

기본적으로 비공개입니다. 다른 사람에게 보여주려면 그 페이지의 공유 메뉴에서 직접 공유하세요.

## 다시 빌드하고 반영하는 방법

```bash
pnpm run build:standalone
```

결과물은 `dist-standalone/bdo-meeting-room.html` 한 개 파일로 나옵니다. 이 파일을 같은 주소로 다시
게시하면 위 주소가 그대로 업데이트됩니다. (주소는 바뀌지 않습니다.)

## 구성

| 파일 | 역할 |
| --- | --- |
| `standalone/index.html` | 빌드용 진입 페이지 |
| `standalone/main.tsx` | `app/page.tsx`를 브라우저에 그려주는 진입 코드 |
| `vite.standalone.config.ts` | Next.js/vinext 서버 기능 없이 브라우저용으로만 빌드하는 설정 |
| `scripts/build-standalone.mjs` | 빌드 결과(JS·CSS·로고)를 한 개 파일로 합치는 스크립트 |

## 참고

- 로고는 파일 안에 직접 포함되므로 외부에서 불러오지 않습니다.
- 본문 글꼴은 외부 웹폰트를 불러오지 못하면 시스템 한글 글꼴(맑은 고딕 등)로 자동 대체됩니다.
- 예약 내용은 브라우저 메모리에만 저장돼서 새로고침하면 초기화됩니다. 실제로 저장되게 하려면
  데이터베이스 연동이 필요합니다.
