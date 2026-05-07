export function calculateSuggestedMinutes(action) {
  const now = new Date();
  // Chuyển sang giờ VN (+7)
  const vnTime = new Date(now.getTime() + 7 * 3600 * 1000);
  const h = vnTime.getUTCHours();
  const m = vnTime.getUTCMinutes();
  const totalMinutes = h * 60 + m;
  
  let suggest = 0;
  if (action === "checkin") {
    // Giờ làm bắt đầu 08:30
    const startMinutes = 8 * 60 + 30;
    if (totalMinutes > startMinutes && totalMinutes < 12 * 60) { // Trễ sáng
      suggest = totalMinutes - startMinutes;
    } else if (totalMinutes >= 13 * 60 + 30 && totalMinutes < 17 * 60 + 30) { // Trễ chiều
      suggest = totalMinutes - (13 * 60 + 30);
    }
  } else if (action === "checkout") {
    // Giờ về 17:30
    const endMinutes = 17 * 60 + 30;
    if (totalMinutes < endMinutes && totalMinutes > 13 * 60) {
      suggest = endMinutes - totalMinutes;
    }
  }
  
  // Làm tròn lên bội của 5 phút
  if (suggest > 0) {
    return Math.ceil(suggest / 5) * 5;
  }
  return 0;
}
