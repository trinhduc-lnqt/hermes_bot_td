const { config } = require('./src/config.js'); // Cannot require ES module, let's write a self-contained script

const configTz = "Asia/Ho_Chi_Minh";

function test(now) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: configTz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(now).reduce((acc, part) => {
    if (part.type !== "literal") acc[part.type] = part.value;
    return acc;
  }, {});
  
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  
  return { parts, hour, minute };
}

console.log(test(new Date("2026-05-09T08:00:00+07:00")));
console.log(test(new Date("2026-05-09T17:00:00+07:00")));
console.log(test(new Date("2026-05-09T07:00:00+07:00")));
