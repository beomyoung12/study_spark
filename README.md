# 공부불씨

3~4명이 초대링크로 주간 공부계획을 공유하는 모바일 웹앱입니다.

## 지금 되는 것

- 월~일, 08:00~24:00 주간 시간표
- 기본 공부시간 09:00~23:00
- 아침 08:00~09:00, 점심 12:00~13:00, 저녁 18:00~19:00 기본 제외 및 직접 변경
- 수업·고정 일정과 공부시간을 30분 단위로 켜고 끄기
- 공부 블록을 한 번 눌러 과목·할 일 입력
- 공부 블록을 길게 누르고 위·아래로 끌어 30분 단위로 길이 조절
- 이름, 주간·오늘 계획시간, 공부 블록 수 표시
- Supabase 연결 전에는 현재 기기에 자동 저장되는 체험 모드
- Supabase 연결 후 그룹 생성, 초대링크 참여, 그룹원 시간표 실시간 공유
- 휴대폰 홈 화면에 설치 가능한 PWA

## GitHub만으로 되나요?

GitHub Pages가 **화면 파일의 무료 호스팅**을 맡으므로 별도 유료 호스팅은 필요 없습니다. 다만 GitHub Pages에는 여러 사람의 데이터를 저장할 데이터베이스가 없습니다.

- 혼자 한 기기에서 사용: GitHub Pages만으로 가능
- 3~4명이 초대·공유: GitHub Pages + Supabase 무료 프로젝트 필요

이 규모라면 둘 다 무료 범위로 충분합니다.

## 1. 먼저 혼자 실행해 보기

VS Code에서 이 폴더를 연 뒤 터미널에서 다음을 실행합니다.

```powershell
python -m http.server 4173
```

브라우저에서 `http://127.0.0.1:4173`을 엽니다. 이때는 `config.js` 값이 비어 있으므로 체험 모드입니다.

## 2. 그룹 공유 연결하기 (최초 1회, 약 5분)

1. [Supabase](https://supabase.com/)에서 무료 프로젝트를 만듭니다.
2. 왼쪽 **SQL Editor** → **New query**에서 `supabase-schema.sql` 전체를 붙여넣고 **Run**을 누릅니다.
3. **Authentication → Providers → Anonymous**를 켭니다. 이메일 회원가입 없이 초대받은 기기를 구분하기 위한 설정입니다.
4. **Project Settings → API**에서 다음 두 값을 찾습니다.
   - Project URL
   - Publishable key 또는 anon public key
5. `config.js`를 열어 다음처럼 붙여넣습니다.

```js
window.STUDY_SPARK_CONFIG = {
  supabaseUrl: "https://프로젝트주소.supabase.co",
  supabaseAnonKey: "여기에-publishable-또는-anon-key",
};
```

`service_role` 키는 절대로 넣지 마세요. 웹에 공개해도 되는 것은 publishable/anon 키이며, 실제 보호는 `supabase-schema.sql`의 사용자별 보안 규칙이 담당합니다.

## 3. GitHub Pages에 올리기

### 가장 쉬운 방법: GitHub 웹사이트

1. GitHub에서 **New repository**를 누르고 저장소를 하나 만듭니다. 공개 저장소(Public)로 만드는 것이 가장 간단합니다.
2. 저장소가 완전히 비어 있다면 **Add file**은 보이지 않습니다. 화면의 **Quick setup** 아래 문장에 있는 **uploading an existing file** 링크를 누릅니다.
3. README를 넣어 저장소를 만들었다면 파일 목록 오른쪽 위의 **Add file → Upload files**를 누릅니다. 창이 좁으면 **Add file** 대신 `+` 아이콘이나 `…` 메뉴로 보일 수 있습니다.
4. `study-spark` 폴더 자체가 아니라 **그 안의 파일 전체**를 업로드 칸에 끌어 놓고, 아래의 **Commit changes**를 누릅니다. `index.html`이 저장소 첫 화면에 바로 보여야 합니다.
5. 저장소 **Settings → Pages**로 갑니다. Settings가 안 보이면 저장소 상단의 `…` 메뉴를 엽니다.
6. **Build and deployment**에서 **Deploy from a branch**를 선택합니다.
7. Branch는 `main`, 폴더는 `/(root)`를 선택하고 **Save**를 누릅니다.
8. 1~3분 뒤 같은 화면에 `https://아이디.github.io/저장소이름/` 주소가 표시됩니다.

### Git 명령으로 올리는 방법

```powershell
git init
git add .
git commit -m "공부불씨 첫 배포"
git branch -M main
git remote add origin https://github.com/내아이디/저장소이름.git
git push -u origin main
```

그다음 GitHub의 **Settings → Pages**에서 `main` / `/(root)`를 선택합니다.

## 4. 친구 초대

1. 배포된 주소를 휴대폰에서 엽니다.
2. 톱니바퀴 → 이름 저장 → **새 그룹 만들기**를 누릅니다.
3. 상단 **초대링크**를 눌러 카카오톡 등으로 전달합니다.
4. 친구가 링크를 열고 **참여하기**를 누르면 그룹원이 됩니다.

각 휴대폰은 익명 로그인 정보를 브라우저에 보관합니다. 브라우저 저장공간을 지우거나 시크릿 모드를 쓰면 새 사용자로 인식될 수 있습니다.

## 파일 구성

| 파일 | 역할 |
|---|---|
| `index.html` | 화면 구조 |
| `styles.css` | 모바일 디자인과 시간표 모양 |
| `app.js` | 시간표 편집, 초대, 동기화 동작 |
| `config.js` | Supabase 공개 연결값 |
| `supabase-schema.sql` | 데이터베이스와 보안 규칙 |
| `manifest.webmanifest`, `service-worker.js` | 홈 화면 설치와 앱 파일 캐시 |
