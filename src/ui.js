export const ICON = Object.freeze({
  back: "⬅️",
  calendar: "📅",
  clipboard: "📋",
  detail: "📄",
  delete: "🗑️",
  error: "❌",
  eye: "👁️",
  good: "🟢",
  home: "🏠",
  leaderboard: "👑",
  kpi: "🎯",
  menu: "📌",
  next: "➡️",
  point: "💎",
  poor: "🔴",
  realtime: "⚡",
  refresh: "🔄",
  room: "🏢",
  success: "✅",
  test: "🧪",
  time: "🕒",
  total: "📊",
  warning: "🟡",
  user: "👤",
  week: "🗓️",
  lock: "🔐"
});

export const TEXT = Object.freeze({
  button: Object.freeze({
    account: "Tài khoản Hermes",
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
