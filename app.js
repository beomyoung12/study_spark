const DAYS = ["월", "화", "수", "목", "금", "토", "일"];
const START_MINUTE = 8 * 60;
const END_MINUTE = 24 * 60;
const SLOT_MINUTES = 30;
const SLOT_COUNT = (END_MINUTE - START_MINUTE) / SLOT_MINUTES;
const LOCAL_USER_ID = "local-user";
const STORAGE_KEYS = {
  schedule: "studySparkSchedule.v1",
  profile: "studySparkProfile.v1",
};

const $ = (selector) => document.querySelector(selector);
const elements = {
  groupName: $("#groupName"),
  connectionBadge: $("#connectionBadge"),
  inviteButton: $("#inviteButton"),
  openSettings: $("#openSettings"),
  weeklyHours: $("#weeklyHours"),
  todayHours: $("#todayHours"),
  blockCount: $("#blockCount"),
  syncStatus: $("#syncStatus"),
  memberTabs: $("#memberTabs"),
  scheduleTitle: $("#scheduleTitle"),
  modeHint: $("#modeHint"),
  mealButton: $("#mealButton"),
  scheduleGrid: $("#scheduleGrid"),
  toast: $("#toast"),
  subjectDialog: $("#subjectDialog"),
  subjectForm: $("#subjectForm"),
  subjectTime: $("#subjectTime"),
  subjectInput: $("#subjectInput"),
  clearSubject: $("#clearSubject"),
  mealDialog: $("#mealDialog"),
  mealForm: $("#mealForm"),
  mealFields: $("#mealFields"),
  settingsDialog: $("#settingsDialog"),
  settingsForm: $("#settingsForm"),
  displayNameInput: $("#displayNameInput"),
  createGroupButton: $("#createGroupButton"),
  joinGroupButton: $("#joinGroupButton"),
  resetSchedule: $("#resetSchedule"),
  groupDialog: $("#groupDialog"),
  groupForm: $("#groupForm"),
  groupDialogEyebrow: $("#groupDialogEyebrow"),
  groupDialogTitle: $("#groupDialogTitle"),
  groupNameLabel: $("#groupNameLabel"),
  groupNameInput: $("#groupNameInput"),
  inviteCodeLabel: $("#inviteCodeLabel"),
  inviteCodeInput: $("#inviteCodeInput"),
  groupDialogNote: $("#groupDialogNote"),
  groupSubmit: $("#groupSubmit"),
};

let supabase = null;
let currentUserId = LOCAL_USER_ID;
let currentGroup = null;
let members = [];
let selectedUserId = LOCAL_USER_ID;
let editMode = "plan";
let saveTimer = null;
let activeSubjectRange = null;
let groupDialogMode = "create";
let realtimeChannel = null;
let toastTimer = null;
let pressState = null;
let suppressClickUntil = 0;
const schedules = new Map();

function blankMatrix(valueFactory) {
  return Array.from({ length: 7 }, () =>
    Array.from({ length: SLOT_COUNT }, () => valueFactory()),
  );
}

function defaultSchedule() {
  return {
    version: 1,
    meals: {
      breakfast: { label: "아침", start: 8 * 60, end: 9 * 60 },
      lunch: { label: "점심", start: 12 * 60, end: 13 * 60 },
      dinner: { label: "저녁", start: 18 * 60, end: 19 * 60 },
    },
    unavailable: blankMatrix(() => false),
    overrides: blankMatrix(() => null),
    subjects: blankMatrix(() => ""),
  };
}

function normalizeMatrix(value, fallback) {
  return Array.from({ length: 7 }, (_, day) =>
    Array.from({ length: SLOT_COUNT }, (_, slot) => {
      const candidate = value?.[day]?.[slot];
      return candidate === undefined ? fallback : candidate;
    }),
  );
}

function normalizeSchedule(value) {
  const defaults = defaultSchedule();
  if (!value || typeof value !== "object") return defaults;
  const meals = {};
  for (const [key, fallback] of Object.entries(defaults.meals)) {
    const meal = value.meals?.[key] ?? {};
    meals[key] = {
      label: String(meal.label ?? fallback.label),
      start: Number(meal.start ?? fallback.start),
      end: Number(meal.end ?? fallback.end),
    };
  }
  return {
    version: 1,
    meals,
    unavailable: normalizeMatrix(value.unavailable, false).map((row) => row.map(Boolean)),
    overrides: normalizeMatrix(value.overrides, null).map((row) =>
      row.map((item) => (typeof item === "boolean" ? item : null)),
    ),
    subjects: normalizeMatrix(value.subjects, "").map((row) =>
      row.map((item) => String(item ?? "").slice(0, 40)),
    ),
  };
}

function loadLocalProfile() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEYS.profile)) ?? { displayName: "나" };
  } catch {
    return { displayName: "나" };
  }
}

function loadLocalSchedule() {
  try {
    return normalizeSchedule(JSON.parse(localStorage.getItem(STORAGE_KEYS.schedule)));
  } catch {
    return defaultSchedule();
  }
}

function saveLocalProfile(profile) {
  localStorage.setItem(STORAGE_KEYS.profile, JSON.stringify(profile));
}

function saveLocalSchedule(schedule) {
  localStorage.setItem(STORAGE_KEYS.schedule, JSON.stringify(schedule));
}

function selectedSchedule() {
  return schedules.get(selectedUserId) ?? defaultSchedule();
}

function ownSchedule() {
  return schedules.get(currentUserId) ?? defaultSchedule();
}

function minuteForSlot(slot) {
  return START_MINUTE + slot * SLOT_MINUTES;
}

function formatTime(minute) {
  if (minute === 24 * 60) return "24:00";
  const hour = Math.floor(minute / 60);
  const mins = minute % 60;
  return `${String(hour).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;
}

function mealForMinute(schedule, minute) {
  return Object.values(schedule.meals).find(
    (meal) => minute >= meal.start && minute < meal.end,
  );
}

function defaultStudyAt(schedule, slot) {
  const minute = minuteForSlot(slot);
  return minute >= 9 * 60 && minute < 23 * 60 && !mealForMinute(schedule, minute);
}

function isStudyAt(schedule, day, slot) {
  if (schedule.unavailable[day][slot]) return false;
  const override = schedule.overrides[day][slot];
  return typeof override === "boolean" ? override : defaultStudyAt(schedule, slot);
}

function cellKind(schedule, day, slot) {
  if (schedule.unavailable[day][slot]) return "busy";
  if (isStudyAt(schedule, day, slot)) return "study";
  if (mealForMinute(schedule, minuteForSlot(slot))) return "meal";
  return "off";
}

function findBlock(schedule, day, slot) {
  if (!isStudyAt(schedule, day, slot)) return null;
  let start = slot;
  let end = slot;
  while (start > 0 && isStudyAt(schedule, day, start - 1)) start -= 1;
  while (end < SLOT_COUNT - 1 && isStudyAt(schedule, day, end + 1)) end += 1;
  return { day, start, end };
}

function plannedSlots(schedule, day = null) {
  const days = day === null ? [...Array(7).keys()] : [day];
  return days.reduce(
    (total, dayIndex) =>
      total + schedule.unavailable[dayIndex].filter((_, slot) => isStudyAt(schedule, dayIndex, slot)).length,
    0,
  );
}

function countBlocks(schedule) {
  let count = 0;
  for (let day = 0; day < 7; day += 1) {
    let previous = false;
    for (let slot = 0; slot < SLOT_COUNT; slot += 1) {
      const active = isStudyAt(schedule, day, slot);
      if (active && !previous) count += 1;
      previous = active;
    }
  }
  return count;
}

function todayIndex() {
  return (new Date().getDay() + 6) % 7;
}

function displayHours(slots) {
  const hours = slots / 2;
  return Number.isInteger(hours) ? `${hours}시간` : `${hours.toFixed(1)}시간`;
}

function showToast(message) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.add("show");
  toastTimer = setTimeout(() => elements.toast.classList.remove("show"), 2600);
}

function setSyncStatus(message) {
  elements.syncStatus.textContent = message;
}

function currentMember() {
  return members.find((member) => member.id === selectedUserId) ?? members[0];
}

function renderMembers() {
  elements.memberTabs.replaceChildren();
  for (const member of members) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `member-tab${member.id === selectedUserId ? " active" : ""}`;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", String(member.id === selectedUserId));
    button.textContent = member.displayName;
    const small = document.createElement("small");
    small.textContent = displayHours(plannedSlots(schedules.get(member.id) ?? defaultSchedule()));
    button.append(small);
    button.addEventListener("click", () => {
      selectedUserId = member.id;
      if (selectedUserId !== currentUserId) editMode = "plan";
      renderAll();
    });
    elements.memberTabs.append(button);
  }
}

function renderSummary() {
  const schedule = selectedSchedule();
  elements.weeklyHours.textContent = displayHours(plannedSlots(schedule));
  elements.todayHours.textContent = displayHours(plannedSlots(schedule, todayIndex()));
  elements.blockCount.textContent = `${countBlocks(schedule)}개`;
}

function renderToolbar() {
  const member = currentMember();
  const own = selectedUserId === currentUserId;
  elements.scheduleTitle.textContent = own
    ? "내 공부시간표"
    : `${member?.displayName ?? "그룹원"}의 공부시간표`;
  const hints = {
    plan: own
      ? "블록을 누르면 공부 내용을 적고, 길게 눌러 위·아래로 늘릴 수 있어요."
      : "다른 그룹원의 계획은 읽기 전용이에요.",
    unavailable: "수업이나 고정 일정을 30분 단위로 표시하세요.",
    study: "공부시간을 30분 단위로 켜거나 끄세요.",
  };
  elements.modeHint.textContent = hints[editMode];
  elements.mealButton.disabled = !own;
  for (const button of document.querySelectorAll("[data-mode]")) {
    button.classList.toggle("active", button.dataset.mode === editMode);
    button.disabled = !own && button.dataset.mode !== "plan";
  }
}

function subjectAt(schedule, day, slot) {
  return schedule.subjects[day][slot]?.trim() ?? "";
}

function renderGrid() {
  const schedule = selectedSchedule();
  const own = selectedUserId === currentUserId;
  const fragment = document.createDocumentFragment();
  const corner = document.createElement("div");
  corner.className = "corner-cell";
  corner.textContent = "시간";
  fragment.append(corner);

  DAYS.forEach((day, dayIndex) => {
    const header = document.createElement("div");
    header.className = `day-header${dayIndex === todayIndex() ? " today" : ""}`;
    header.textContent = day;
    fragment.append(header);
  });

  for (let slot = 0; slot < SLOT_COUNT; slot += 1) {
    const time = document.createElement("div");
    time.className = "time-label";
    time.textContent = formatTime(minuteForSlot(slot));
    time.style.gridRow = String(slot + 2);
    time.style.gridColumn = "1";
    fragment.append(time);

    for (let day = 0; day < 7; day += 1) {
      const kind = cellKind(schedule, day, slot);
      const block = kind === "study" ? findBlock(schedule, day, slot) : null;
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = [
        "slot-cell",
        kind,
        slot % 2 === 0 ? "hour-start" : "",
        !own ? "readonly" : "",
        block?.start === slot ? "block-start" : "",
        block?.end === slot ? "block-end" : "",
      ]
        .filter(Boolean)
        .join(" ");
      cell.dataset.day = String(day);
      cell.dataset.slot = String(slot);
      cell.style.gridRow = String(slot + 2);
      cell.style.gridColumn = String(day + 2);

      const subject = subjectAt(schedule, day, slot);
      if (kind === "study" && subject && (!block || block.start === slot)) {
        const label = document.createElement("span");
        label.className = "slot-subject";
        label.textContent = subject;
        cell.append(label);
      } else if (kind === "meal" && slot % 2 === 0) {
        const state = document.createElement("span");
        state.className = "slot-state";
        state.textContent = mealForMinute(schedule, minuteForSlot(slot))?.label ?? "식사";
        cell.append(state);
      } else if (kind === "busy" && slot % 2 === 0) {
        const state = document.createElement("span");
        state.className = "slot-state";
        state.textContent = "수업";
        cell.append(state);
      }
      const readable = `${DAYS[day]}요일 ${formatTime(minuteForSlot(slot))}, ${
        kind === "study" ? "공부시간" : kind === "meal" ? "식사시간" : kind === "busy" ? "수업 또는 일정" : "비활성"
      }${subject ? `, ${subject}` : ""}`;
      cell.setAttribute("aria-label", readable);
      fragment.append(cell);
    }
  }

  elements.scheduleGrid.replaceChildren(fragment);
}

function renderConnection() {
  elements.groupName.textContent = currentGroup?.name ?? "나의 공부방";
  const shared = Boolean(supabase && currentGroup);
  elements.connectionBadge.textContent = shared ? "공유 중" : "체험 모드";
  elements.connectionBadge.className = `status-badge ${shared ? "shared" : "demo"}`;
  elements.inviteButton.disabled = !shared;
}

function renderAll() {
  renderConnection();
  renderMembers();
  renderSummary();
  renderToolbar();
  renderGrid();
}

function markOwnScheduleChanged(message = "저장 중…") {
  const schedule = ownSchedule();
  schedules.set(currentUserId, schedule);
  saveLocalSchedule(schedule);
  renderAll();
  setSyncStatus(supabase && currentGroup ? message : "이 기기에 저장됨");
  clearTimeout(saveTimer);
  if (supabase && currentGroup) saveTimer = setTimeout(syncOwnSchedule, 450);
}

async function syncOwnSchedule() {
  try {
    const { error } = await supabase.from("schedules").upsert(
      {
        user_id: currentUserId,
        group_id: currentGroup.id,
        payload: ownSchedule(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,group_id" },
    );
    if (error) throw error;
    setSyncStatus("방금 동기화됨");
  } catch (error) {
    console.error(error);
    setSyncStatus("동기화 실패 · 이 기기에는 저장됨");
  }
}

function toggleCell(day, slot) {
  if (selectedUserId !== currentUserId) return;
  const schedule = ownSchedule();
  if (editMode === "unavailable") {
    const next = !schedule.unavailable[day][slot];
    schedule.unavailable[day][slot] = next;
    if (next) {
      schedule.overrides[day][slot] = null;
      schedule.subjects[day][slot] = "";
    }
    markOwnScheduleChanged();
    return;
  }
  if (editMode === "study") {
    schedule.overrides[day][slot] = !isStudyAt(schedule, day, slot);
    if (!schedule.overrides[day][slot]) schedule.subjects[day][slot] = "";
    markOwnScheduleChanged();
  }
}

function openSubjectEditor(day, slot) {
  const schedule = ownSchedule();
  const block = findBlock(schedule, day, slot);
  if (!block) return;
  activeSubjectRange = block;
  elements.subjectTime.textContent = `${DAYS[day]}요일 ${formatTime(
    minuteForSlot(block.start),
  )}–${formatTime(minuteForSlot(block.end + 1))}`;
  elements.subjectInput.value = subjectAt(schedule, day, slot);
  elements.subjectDialog.showModal();
  setTimeout(() => elements.subjectInput.focus(), 30);
}

function handleGridClick(event) {
  const cell = event.target.closest(".slot-cell");
  if (!cell || Date.now() < suppressClickUntil || selectedUserId !== currentUserId) return;
  const day = Number(cell.dataset.day);
  const slot = Number(cell.dataset.slot);
  if (editMode === "plan") {
    if (isStudyAt(ownSchedule(), day, slot)) openSubjectEditor(day, slot);
    else showToast("공부시간 수정에서 먼저 이 시간을 켜 주세요.");
  } else {
    toggleCell(day, slot);
  }
}

function clearResizePreview() {
  for (const cell of elements.scheduleGrid.querySelectorAll(".resizing")) {
    cell.classList.remove("resizing");
  }
}

function slotFromPointer(clientY) {
  const first = elements.scheduleGrid.querySelector('.slot-cell[data-slot="0"]');
  if (!first) return 0;
  const firstRect = first.getBoundingClientRect();
  const height = firstRect.height || 42;
  return Math.max(0, Math.min(SLOT_COUNT - 1, Math.floor((clientY - firstRect.top) / height)));
}

function previewResize(state, target) {
  clearResizePreview();
  const start = state.edge === "start" ? Math.min(target, state.block.end) : state.block.start;
  const end = state.edge === "end" ? Math.max(target, state.block.start) : state.block.end;
  for (let slot = start; slot <= end; slot += 1) {
    elements.scheduleGrid
      .querySelector(`.slot-cell[data-day="${state.day}"][data-slot="${slot}"]`)
      ?.classList.add("resizing");
  }
}

function beginLongPress() {
  if (!pressState) return;
  pressState.long = true;
  navigator.vibrate?.(25);
  previewResize(pressState, pressState.slot);
  showToast(`${pressState.edge === "start" ? "시작" : "끝"} 경계를 위·아래로 움직이세요.`);
}

function handlePointerDown(event) {
  const cell = event.target.closest(".slot-cell");
  if (
    !cell ||
    editMode !== "plan" ||
    selectedUserId !== currentUserId ||
    !cell.classList.contains("study")
  ) return;
  const day = Number(cell.dataset.day);
  const slot = Number(cell.dataset.slot);
  const block = findBlock(ownSchedule(), day, slot);
  if (!block) return;
  const edge = slot - block.start <= block.end - slot ? "start" : "end";
  pressState = {
    day,
    slot,
    block,
    edge,
    target: slot,
    long: false,
    pointerId: event.pointerId,
    timer: setTimeout(beginLongPress, 430),
  };
  cell.setPointerCapture?.(event.pointerId);
}

function handlePointerMove(event) {
  if (!pressState || event.pointerId !== pressState.pointerId) return;
  if (!pressState.long) return;
  event.preventDefault();
  pressState.target = slotFromPointer(event.clientY);
  previewResize(pressState, pressState.target);
}

function applyResize(state) {
  const schedule = ownSchedule();
  const { day, block } = state;
  const copiedSubject =
    schedule.subjects[day].slice(block.start, block.end + 1).find((value) => value.trim()) ?? "";
  if (state.edge === "start") {
    const newStart = Math.min(state.target, block.end);
    for (let slot = Math.min(newStart, block.start); slot <= block.end; slot += 1) {
      const active = slot >= newStart;
      if (active && schedule.unavailable[day][slot]) continue;
      schedule.overrides[day][slot] = active;
      schedule.subjects[day][slot] = active ? copiedSubject : "";
    }
  } else {
    const newEnd = Math.max(state.target, block.start);
    for (let slot = block.start; slot <= Math.max(newEnd, block.end); slot += 1) {
      const active = slot <= newEnd;
      if (active && schedule.unavailable[day][slot]) continue;
      schedule.overrides[day][slot] = active;
      schedule.subjects[day][slot] = active ? copiedSubject : "";
    }
  }
  markOwnScheduleChanged();
}

function finishPointer(event) {
  if (!pressState || event.pointerId !== pressState.pointerId) return;
  clearTimeout(pressState.timer);
  if (pressState.long) {
    applyResize(pressState);
    suppressClickUntil = Date.now() + 550;
  }
  clearResizePreview();
  pressState = null;
}

function cancelPointer(event) {
  if (!pressState || event.pointerId !== pressState.pointerId) return;
  clearTimeout(pressState.timer);
  clearResizePreview();
  pressState = null;
}

function makeTimeOptions(selected, includeEnd = false) {
  const max = includeEnd ? END_MINUTE : END_MINUTE - SLOT_MINUTES;
  let html = "";
  for (let minute = START_MINUTE; minute <= max; minute += SLOT_MINUTES) {
    html += `<option value="${minute}"${minute === selected ? " selected" : ""}>${formatTime(minute)}</option>`;
  }
  return html;
}

function renderMealFields() {
  const schedule = ownSchedule();
  elements.mealFields.innerHTML = Object.entries(schedule.meals)
    .map(
      ([key, meal]) => `
        <div class="meal-row">
          <strong>${meal.label}</strong>
          <select name="${key}-start" aria-label="${meal.label} 시작">${makeTimeOptions(meal.start)}</select>
          <span>~</span>
          <select name="${key}-end" aria-label="${meal.label} 종료">${makeTimeOptions(meal.end, true)}</select>
        </div>`,
    )
    .join("");
}

function openGroupDialog(mode, presetCode = "") {
  if (!supabase) {
    showToast("그룹 공유는 config.js에 Supabase 값을 넣은 뒤 사용할 수 있어요.");
    return;
  }
  groupDialogMode = mode;
  const creating = mode === "create";
  elements.groupDialogEyebrow.textContent = creating ? "공부방 열기" : "초대받은 공부방";
  elements.groupDialogTitle.textContent = creating ? "새 그룹 만들기" : "그룹 참여하기";
  elements.groupNameLabel.hidden = !creating;
  elements.inviteCodeLabel.hidden = creating;
  elements.groupSubmit.textContent = creating ? "만들기" : "참여하기";
  elements.groupDialogNote.textContent = creating
    ? "만들고 나면 초대링크를 복사해 친구에게 보내면 됩니다."
    : "초대링크의 코드는 자동으로 입력됩니다.";
  elements.groupNameInput.value = "";
  elements.inviteCodeInput.value = presetCode.toUpperCase();
  elements.groupDialog.showModal();
}

async function copyInviteLink() {
  if (!currentGroup) return;
  const url = new URL(location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("invite", currentGroup.invite_code);
  try {
    await navigator.clipboard.writeText(url.toString());
    showToast("초대링크를 복사했어요.");
  } catch {
    window.prompt("이 링크를 복사해 전달하세요.", url.toString());
  }
}

async function saveProfileName(displayName) {
  const clean = displayName.trim().slice(0, 16) || "나";
  saveLocalProfile({ displayName: clean });
  const localMember = members.find((member) => member.id === currentUserId);
  if (localMember) localMember.displayName = clean;
  if (supabase) {
    const { error } = await supabase.from("profiles").upsert({
      id: currentUserId,
      display_name: clean,
      updated_at: new Date().toISOString(),
    });
    if (error) throw error;
  }
  renderAll();
}

async function loadGroup(groupId) {
  if (!supabase) return;
  setSyncStatus("그룹 불러오는 중…");
  const [{ data: group, error: groupError }, { data: membershipRows, error: memberError }] =
    await Promise.all([
      supabase.from("groups").select("id,name,invite_code").eq("id", groupId).single(),
      supabase.from("group_members").select("user_id").eq("group_id", groupId),
    ]);
  if (groupError) throw groupError;
  if (memberError) throw memberError;
  currentGroup = group;
  const userIds = membershipRows.map((row) => row.user_id);
  const [{ data: profiles, error: profileError }, { data: scheduleRows, error: scheduleError }] =
    await Promise.all([
      supabase.from("profiles").select("id,display_name").in("id", userIds),
      supabase.from("schedules").select("user_id,payload").eq("group_id", groupId),
    ]);
  if (profileError) throw profileError;
  if (scheduleError) throw scheduleError;
  const profileMap = new Map((profiles ?? []).map((profile) => [profile.id, profile.display_name]));
  members = userIds.map((id) => ({
    id,
    displayName: profileMap.get(id) ?? (id === currentUserId ? loadLocalProfile().displayName : "그룹원"),
  }));
  for (const member of members) {
    const row = scheduleRows?.find((item) => item.user_id === member.id);
    if (row) schedules.set(member.id, normalizeSchedule(row.payload));
    else if (!schedules.has(member.id)) schedules.set(member.id, defaultSchedule());
  }
  selectedUserId = userIds.includes(selectedUserId) ? selectedUserId : currentUserId;
  setSyncStatus("그룹과 동기화됨");
  subscribeToGroup(groupId);
  renderAll();
}

function subscribeToGroup(groupId) {
  if (realtimeChannel) supabase.removeChannel(realtimeChannel);
  realtimeChannel = supabase
    .channel(`study-spark-${groupId}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "schedules", filter: `group_id=eq.${groupId}` },
      (payload) => {
        const row = payload.new;
        if (row?.user_id) {
          schedules.set(row.user_id, normalizeSchedule(row.payload));
          renderAll();
          setSyncStatus("방금 동기화됨");
        }
      },
    )
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "group_members", filter: `group_id=eq.${groupId}` },
      () => loadGroup(groupId).catch(console.error),
    )
    .subscribe();
}

async function findExistingGroup() {
  const { data, error } = await supabase
    .from("group_members")
    .select("group_id")
    .eq("user_id", currentUserId)
    .limit(1);
  if (error) throw error;
  return data?.[0]?.group_id ?? null;
}

async function initBackend() {
  const config = window.STUDY_SPARK_CONFIG ?? {};
  const localProfile = loadLocalProfile();
  schedules.set(LOCAL_USER_ID, loadLocalSchedule());
  members = [{ id: LOCAL_USER_ID, displayName: localProfile.displayName }];
  renderAll();

  if (!config.supabaseUrl || !config.supabaseAnonKey) {
    setSyncStatus("이 기기에 저장됨 · 공유 설정 전");
    return;
  }

  try {
    setSyncStatus("공유 서버 연결 중…");
    const { createClient } = await import(
      "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm"
    );
    supabase = createClient(config.supabaseUrl, config.supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true },
    });
    let { data: sessionData } = await supabase.auth.getSession();
    let session = sessionData.session;
    if (!session) {
      const { data, error } = await supabase.auth.signInAnonymously();
      if (error) throw error;
      session = data.session;
    }
    currentUserId = session.user.id;
    selectedUserId = currentUserId;
    const localSchedule = schedules.get(LOCAL_USER_ID) ?? defaultSchedule();
    schedules.delete(LOCAL_USER_ID);
    schedules.set(currentUserId, localSchedule);
    await saveProfileName(localProfile.displayName);
    const existingGroupId = await findExistingGroup();
    const inviteCode = new URLSearchParams(location.search).get("invite")?.trim();
    if (existingGroupId) await loadGroup(existingGroupId);
    else {
      members = [{ id: currentUserId, displayName: localProfile.displayName }];
      renderAll();
      setSyncStatus("연결됨 · 그룹을 만들거나 참여하세요");
    }
    if (inviteCode && !existingGroupId) openGroupDialog("join", inviteCode);
  } catch (error) {
    console.error(error);
    supabase = null;
    currentUserId = LOCAL_USER_ID;
    selectedUserId = LOCAL_USER_ID;
    schedules.clear();
    schedules.set(LOCAL_USER_ID, loadLocalSchedule());
    members = [{ id: LOCAL_USER_ID, displayName: localProfile.displayName }];
    setSyncStatus("공유 연결 실패 · 이 기기에 저장됨");
    renderAll();
    showToast("공유 서버 연결에 실패했어요. config.js와 Supabase 설정을 확인하세요.");
  }
}

async function handleGroupSubmit(event) {
  event.preventDefault();
  if (!supabase) return;
  const displayName = loadLocalProfile().displayName || "나";
  const functionName = groupDialogMode === "create" ? "create_study_group" : "join_study_group";
  const params =
    groupDialogMode === "create"
      ? { p_group_name: elements.groupNameInput.value.trim(), p_display_name: displayName }
      : { p_invite_code: elements.inviteCodeInput.value.trim().toUpperCase(), p_display_name: displayName };
  if (groupDialogMode === "create" && !params.p_group_name) {
    showToast("그룹 이름을 입력해 주세요.");
    return;
  }
  if (groupDialogMode === "join" && !params.p_invite_code) {
    showToast("초대코드를 입력해 주세요.");
    return;
  }
  elements.groupSubmit.disabled = true;
  elements.groupSubmit.textContent = "처리 중…";
  try {
    const { data, error } = await supabase.rpc(functionName, params);
    if (error) throw error;
    const result = Array.isArray(data) ? data[0] : data;
    const groupId = result?.group_id ?? result?.id ?? data;
    if (!groupId) throw new Error("그룹 ID를 받지 못했습니다.");
    elements.groupDialog.close();
    await loadGroup(groupId);
    await syncOwnSchedule();
    showToast(groupDialogMode === "create" ? "공부방을 만들었어요." : "공부방에 참여했어요.");
  } catch (error) {
    console.error(error);
    showToast(error.message?.includes("not found") ? "초대코드를 찾지 못했어요." : `처리 실패: ${error.message}`);
  } finally {
    elements.groupSubmit.disabled = false;
    elements.groupSubmit.textContent = groupDialogMode === "create" ? "만들기" : "참여하기";
  }
}

function installEventHandlers() {
  elements.scheduleGrid.addEventListener("click", handleGridClick);
  elements.scheduleGrid.addEventListener("pointerdown", handlePointerDown);
  elements.scheduleGrid.addEventListener("pointermove", handlePointerMove);
  elements.scheduleGrid.addEventListener("pointerup", finishPointer);
  elements.scheduleGrid.addEventListener("pointercancel", cancelPointer);

  for (const button of document.querySelectorAll("[data-mode]")) {
    button.addEventListener("click", () => {
      if (selectedUserId !== currentUserId) return;
      editMode = button.dataset.mode;
      renderAll();
    });
  }

  elements.subjectForm.addEventListener("submit", (event) => {
    if (event.submitter?.value !== "save" || !activeSubjectRange) return;
    const schedule = ownSchedule();
    const value = elements.subjectInput.value.trim().slice(0, 40);
    for (let slot = activeSubjectRange.start; slot <= activeSubjectRange.end; slot += 1) {
      schedule.subjects[activeSubjectRange.day][slot] = value;
    }
    markOwnScheduleChanged();
    showToast(value ? "공부 계획을 적었어요." : "공부 내용을 지웠어요.");
  });
  elements.clearSubject.addEventListener("click", () => {
    elements.subjectInput.value = "";
    elements.subjectInput.focus();
  });
  for (const button of document.querySelectorAll("[data-subject]")) {
    button.addEventListener("click", () => {
      elements.subjectInput.value = button.dataset.subject;
      elements.subjectInput.focus();
    });
  }

  elements.mealButton.addEventListener("click", () => {
    renderMealFields();
    elements.mealDialog.showModal();
  });
  elements.mealForm.addEventListener("submit", (event) => {
    if (event.submitter?.value !== "save") return;
    const formData = new FormData(elements.mealForm);
    const schedule = ownSchedule();
    for (const key of Object.keys(schedule.meals)) {
      const start = Number(formData.get(`${key}-start`));
      const end = Number(formData.get(`${key}-end`));
      if (end <= start) {
        event.preventDefault();
        showToast("식사 종료는 시작보다 늦어야 해요.");
        return;
      }
      schedule.meals[key].start = start;
      schedule.meals[key].end = end;
    }
    markOwnScheduleChanged();
  });

  elements.openSettings.addEventListener("click", () => {
    elements.displayNameInput.value = loadLocalProfile().displayName;
    elements.settingsDialog.showModal();
  });
  elements.settingsForm.addEventListener("submit", async (event) => {
    if (event.submitter?.value !== "save") return;
    event.preventDefault();
    try {
      await saveProfileName(elements.displayNameInput.value);
      elements.settingsDialog.close();
      showToast("이름을 저장했어요.");
    } catch (error) {
      console.error(error);
      showToast("이름 동기화에 실패했어요.");
    }
  });
  elements.createGroupButton.addEventListener("click", () => {
    elements.settingsDialog.close();
    openGroupDialog("create");
  });
  elements.joinGroupButton.addEventListener("click", () => {
    elements.settingsDialog.close();
    openGroupDialog("join");
  });
  elements.resetSchedule.addEventListener("click", () => {
    if (!confirm("내 시간표를 기본값으로 되돌릴까요? 입력한 공부 내용도 지워집니다.")) return;
    schedules.set(currentUserId, defaultSchedule());
    markOwnScheduleChanged();
    showToast("기본 시간표로 되돌렸어요.");
  });
  elements.inviteButton.addEventListener("click", copyInviteLink);
  elements.groupForm.addEventListener("submit", handleGroupSubmit);
}

function registerWebMcpTools() {
  if (!document.modelContext?.registerTool) return;
  document.modelContext.registerTool({
    name: "get_weekly_study_plan",
    description: "현재 선택된 사용자의 주간 공부시간과 과목 계획을 조회합니다.",
    inputSchema: { type: "object", properties: {} },
    execute: async () => {
      const schedule = selectedSchedule();
      const plan = DAYS.map((day, dayIndex) => ({
        day,
        hours: plannedSlots(schedule, dayIndex) / 2,
        blocks: Array.from({ length: SLOT_COUNT }, (_, slot) => ({
          start: formatTime(minuteForSlot(slot)),
          active: isStudyAt(schedule, dayIndex, slot),
          subject: schedule.subjects[dayIndex][slot],
        })).filter((item) => item.active),
      }));
      return { content: [{ type: "text", text: JSON.stringify(plan, null, 2) }] };
    },
  });
}

installEventHandlers();
registerWebMcpTools();
initBackend();

if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  window.addEventListener("load", () => navigator.serviceWorker.register("./service-worker.js"));
}
