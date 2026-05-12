export const ICON = Object.freeze({
  back: "\u2B05\uFE0F",
  calendar: "\uD83D\uDCC5",
  clipboard: "\uD83D\uDCCB",
  detail: "\uD83D\uDCC4",
  delete: "\uD83D\uDDD1\uFE0F",
  error: "\u274C",
  eye: "\uD83D\uDC41\uFE0F",
  home: "\uD83C\uDFE0",
  kpi: "\uD83C\uDFAF",
  menu: "\uD83D\uDCCC",
  next: "\u27A1\uFE0F",
  success: "\u2705",
  test: "\uD83E\uDDEA",
  user: "\uD83D\uDC64",
  week: "\uD83D\uDDD3\uFE0F",
  lock: "\uD83D\uDD10"
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
    nextDay: "Ngày sau",
    nextDayShort: "Ngày mai",
    previousDay: "Ngày trước",
    previousDayShort: "Hôm qua",
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
