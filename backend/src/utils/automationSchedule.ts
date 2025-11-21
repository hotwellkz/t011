/**
 * Утилиты для работы с расписанием автоматизации
 */

const DEFAULT_TIMEZONE = "Asia/Almaty"; // UTC+6

/**
 * Получает текущее время в указанном часовом поясе
 */
export function getCurrentTimeInTimezone(timezone: string = DEFAULT_TIMEZONE): Date {
  const now = new Date();
  // Используем Intl API для работы с timezone
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const parts = formatter.formatToParts(now);
  const year = parseInt(parts.find((p) => p.type === "year")!.value);
  const month = parseInt(parts.find((p) => p.type === "month")!.value) - 1;
  const day = parseInt(parts.find((p) => p.type === "day")!.value);
  const hour = parseInt(parts.find((p) => p.type === "hour")!.value);
  const minute = parseInt(parts.find((p) => p.type === "minute")!.value);
  const second = parseInt(parts.find((p) => p.type === "second")!.value);

  return new Date(year, month, day, hour, minute, second);
}


/**
 * Получает день недели в указанном часовом поясе
 * Возвращает массив: ["Mon", "1"] для совместимости
 */
export function getDayOfWeekInTimezone(
  date: Date,
  timezone: string = DEFAULT_TIMEZONE
): string[] {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
  });
  
  const dayName = formatter.format(date);
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const dayIndex = dayNames.indexOf(dayName);
  const dayNumber = String(dayIndex === 0 ? 7 : dayIndex); // 1-7, где 1 = воскресенье
  
  return [dayName, dayNumber];
}

/**
 * Вычисляет следующее время запуска автоматизации
 */
export function calculateNextRunAt(
  times: string[], // ["10:00", "15:00"]
  daysOfWeek: string[], // ["Mon", "Tue", "1", "2"]
  timezone: string = DEFAULT_TIMEZONE,
  lastRunAt?: number | null
): number | null {
  if (times.length === 0 || daysOfWeek.length === 0) {
    return null;
  }

  const now = getCurrentTimeInTimezone(timezone);
  const nowUTC = new Date();
  
  // Парсим дни недели
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const validDays = daysOfWeek
    .map((d) => {
      const dayIndex = dayNames.indexOf(d);
      if (dayIndex >= 0) return dayIndex;
      const num = parseInt(d);
      if (num >= 1 && num <= 7) return num === 7 ? 0 : num;
      return null;
    })
    .filter((d): d is number => d !== null);

  if (validDays.length === 0) {
    return null;
  }

  // Парсим времена
  const validTimes = times
    .map((t) => {
      const [h, m] = t.split(":").map(Number);
      if (isNaN(h) || isNaN(m)) return null;
      return { hour: h, minute: m };
    })
    .filter((t): t is { hour: number; minute: number } => t !== null);

  if (validTimes.length === 0) {
    return null;
  }

  // Ищем ближайшее время в ближайшие 7 дней
  let candidate: Date | null = null;
  
  for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
    const checkDate = new Date(now);
    checkDate.setDate(checkDate.getDate() + dayOffset);
    
    const [dayName, dayNumber] = getDayOfWeekInTimezone(checkDate, timezone);
    const dayIndex = dayNames.indexOf(dayName);
    
    if (!validDays.includes(dayIndex)) {
      continue;
    }

    for (const time of validTimes) {
      const candidateDate = new Date(checkDate);
      candidateDate.setHours(time.hour, time.minute, 0, 0);
      
      // Если это сегодня и время уже прошло, пропускаем
      if (dayOffset === 0 && candidateDate <= now) {
        continue;
      }
      
      // Проверяем, не был ли это последний запуск
      if (lastRunAt) {
        const lastRun = new Date(lastRunAt);
        const lastRunInTz = getCurrentTimeInTimezone(timezone);
        lastRunInTz.setTime(lastRun.getTime());
        
        if (
          candidateDate.getDate() === lastRunInTz.getDate() &&
          candidateDate.getMonth() === lastRunInTz.getMonth() &&
          candidateDate.getFullYear() === lastRunInTz.getFullYear() &&
          candidateDate.getHours() === lastRunInTz.getHours() &&
          candidateDate.getMinutes() === lastRunInTz.getMinutes()
        ) {
          continue;
        }
      }
      
      if (!candidate || candidateDate < candidate) {
        candidate = candidateDate;
      }
    }
  }

  if (!candidate) {
    return null;
  }

  // Преобразуем локальное время в указанном timezone в UTC timestamp
  // Используем простой способ: создаем строку даты и парсим с учетом timezone
  const year = candidate.getFullYear();
  const month = candidate.getMonth();
  const day = candidate.getDate();
  const hour = candidate.getHours();
  const minute = candidate.getMinutes();
  
  // Создаем строку в формате ISO
  const dateString = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`;
  
  // Используем временную дату для получения offset
  // Создаем дату как будто это локальное время в указанном timezone
  const tempDate = new Date(dateString);
  
  // Получаем offset для указанного timezone
  const utcString = tempDate.toLocaleString("en-US", { timeZone: "UTC" });
  const tzString = tempDate.toLocaleString("en-US", { timeZone: timezone });
  const utcDate = new Date(utcString);
  const tzDate = new Date(tzString);
  const offset = utcDate.getTime() - tzDate.getTime();
  
  // Корректируем timestamp с учетом offset
  return tempDate.getTime() - offset;
}


/**
 * Форматирует дату для отображения в указанном timezone
 */
export function formatDateInTimezone(
  timestamp: number,
  timezone: string = DEFAULT_TIMEZONE
): string {
  const date = new Date(timestamp);
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

export { DEFAULT_TIMEZONE };

