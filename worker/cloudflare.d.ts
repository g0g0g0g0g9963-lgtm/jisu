// Cloudflare Workers 런타임 전역 타입(D1Database, Fetcher 등)을 들여온다.
// tsconfig의 `types` 목록을 건드리지 않고 이 파일 하나로 포함시킨다.
/// <reference types="@cloudflare/workers-types" />

// 이 사이트가 쓰는 바인딩. `.openai/hosting.json`에서 실제로 연결한 것만 런타임에
// 존재하므로, 아직 연결하지 않은 D1은 선택 항목으로 둔다.
declare namespace Cloudflare {
  interface Env {
    ASSETS: Fetcher;
    DB?: D1Database;
  }
}
