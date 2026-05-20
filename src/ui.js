export const ICON = Object.freeze({
  ai: "\u{1F916}",
  afternoon: "\u{1F324}\uFE0F",
  back: "\u2B05\uFE0F",
  calendar: "\u{1F4C5}",
  calendarAlt: "\u{1F5D3}\uFE0F",
  call: "\u260E\uFE0F",
  clipboard: "\u{1F4CB}",
  customer: "\u{1F465}",
  detail: "\u{1F4C4}",
  delete: "\u{1F5D1}\uFE0F",
  sandwich: "\u{1F96A}",
  phone: "\u{1F4DE}",
  notebook: "\u{1F4D2}",
  desktop: "\u{1F5A5}\uFE0F",
  deploy: "\u{1F680}",
  downTrend: "\u{1F4C9}",
  error: "\u274C",
  eye: "\u{1F441}\uFE0F",
  gift: "\u{1F381}",
  wrench: "\u{1F527}",
  repeat: "\u{1F501}",
  plus: "\u2795",
  laptop: "\u{1F4BB}",
  globe: "\u{1F310}",
  foodBox: "\u{1F961}",
  food: "\u{1F37D}\uFE0F",
  book: "\u{1F4D8}",
  good: "\u{1F7E2}",
  home: "\u{1F3E0}",
  keyboard: "\u2328\uFE0F",
  kpi: "\u{1F3AF}",
  leaderboard: "\u{1F451}",
  light: "\u{1F4A1}",
  lock: "\u{1F510}",
  locked: "\u{1F512}",
  location: "\u{1F4CD}",
  menu: "\u{1F4CC}",
  money: "\u{1F4B0}",
  moneyBill: "\u{1F4B5}",
  morning: "\u2600\uFE0F",
  next: "\u27A1\uFE0F",
  noon: "\u{1F371}",
  note: "\u{1F4DD}",
  plug: "\u{1F50C}",
  point: "\u{1F48E}",
  poor: "\u{1F534}",
  receipt: "\u{1F9FE}",
  realtime: "\u26A1",
  refresh: "\u{1F504}",
  room: "\u{1F3E2}",
  server: "\u{1F4E1}",
  sparkle: "\u2728",
  success: "\u2705",
  test: "\u{1F9EA}",
  ticket: "\u{1F3AB}",
  time: "\u{1F552}",
  timer: "\u23F1\uFE0F",
  tools: "\u{1F6E0}\uFE0F",
  total: "\u{1F4CA}",
  upTrend: "\u{1F4C8}",
  user: "\u{1F464}",
  warning: "\u{1F7E1}",
  warningSign: "\u26A0\uFE0F",
  week: "\u{1F5D3}\uFE0F"
});

export const TEXT = Object.freeze({
  button: Object.freeze({
    account: "Tài khoản Hermes",
    back: "Quay lại",
    backToList: "Quay lại danh sách",
    chooseDate: "Chọn ngày",
    currentUser: "Xem thông tin",
    dashboard: "Tổng hợp",
    deleteAccount: "Xoá tài khoản",
    duty: "Lịch trực",
    detailView: "View chi tiết",
    home: "Trang chủ",
    homeMain: "Về trang chủ",
    kpi: "KPI",
    kpiDeployLive: "KPI Deploy Live",
    pointRealtime: "KPI Live",
    kpiLeaderBoardHaNoi: "KPI Live",
    nextDay: "Ngày sau",
    nextDayShort: "Ngày mai",
    previousDay: "Ngày trước",
    previousDayShort: "Hôm qua",
    refreshLeaderBoard: "Cập nhật",
    thisMonth: "Xem tháng này",
    today: "Hôm nay",
    updateAccount: "Cập nhật",
    workSchedule: "Lịch làm việc",
    week: "Xem cả tuần"
  }),
  testAuto: Object.freeze({
    start: "Đang test luồng thông báo tự động (bỏ qua kiểm tra giờ)...",
    reason: "Test lệnh /testauto",
    success: "Chạy xong hàm tự động!",
    failurePrefix: "Lỗi khi test tự động"
  }),
  testNotify: Object.freeze({
    title: "TEST THÔNG BÁO HERMES",
    latest: "Tin bên dưới là thông báo mới nhất bot đọc được từ Hermes.",
    failurePrefix: "Không test được thông báo Hermes"
  })
});

export function label(icon, text) {
  return `${icon} ${text}`;
}

export function buttonText(key, iconKey = key) {
  return label(ICON[iconKey], TEXT.button[key]);
}

export function statusText(status, text) {
  return label(ICON[status], text);
}
