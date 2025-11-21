import { Router, Request, Response } from "express";
import { getAllChannels, getChannelById, Channel } from "../models/channel";
import { createJob, countActiveJobs } from "../models/videoJob";
import { generateIdeas } from "../services/openaiService";
import { generateVeoPrompt } from "../services/openaiService";
import {
  getCurrentTimeComponentsInTimezone,
  getDayOfWeekInTimezone,
  DEFAULT_TIMEZONE,
  formatDateInTimezone,
} from "../utils/automationSchedule";

const router = Router();

/**
 * Проверяет, нужно ли запускать автоматизацию для канала в текущее время
 * Использует timezone из настроек канала или Asia/Almaty по умолчанию
 */
function shouldRunAutomation(
  channel: Channel,
  intervalMinutes: number = 10
): boolean {
  if (!channel.automation || !channel.automation.enabled) {
    return false;
  }

  // Проверяем, не выполняется ли уже автоматизация
  if (channel.automation.isRunning) {
    console.log(
      `[Automation] Channel ${channel.id} is already running, skipping`
    );
    return false;
  }

  const automation = channel.automation;
  const timezone = automation.timeZone || DEFAULT_TIMEZONE;

  // Получаем текущее время в указанном timezone
  const currentTimeComponents = getCurrentTimeComponentsInTimezone(timezone);
  const currentTimeUTC = new Date();

  // Проверяем день недели в указанном timezone
  const [currentDay, currentDayNumber] = getDayOfWeekInTimezone(
    currentTimeUTC,
    timezone
  );
  const isDayMatch =
    automation.daysOfWeek.includes(currentDay) ||
    automation.daysOfWeek.includes(currentDayNumber);
  if (!isDayMatch) {
    return false;
  }

  // Проверяем время
  const currentHour = currentTimeComponents.hour;
  const currentMinute = currentTimeComponents.minute;

  // Проверяем, есть ли запланированное время в интервале
  for (const scheduledTime of automation.times) {
    if (!scheduledTime || scheduledTime.trim() === "") {
      continue;
    }

    const [scheduledHour, scheduledMinute] = scheduledTime
      .split(":")
      .map(Number);

    // Проверяем, что время уже наступило и в пределах интервала
    const diffMinutes =
      (currentHour * 60 + currentMinute) - (scheduledHour * 60 + scheduledMinute);

    if (diffMinutes >= 0 && diffMinutes <= intervalMinutes) {
      // Проверяем, не было ли уже запуска сегодня для этого времени
      if (automation.lastRunAt) {
        const lastRunDate = new Date(automation.lastRunAt);
        const lastRunFormatter = new Intl.DateTimeFormat("en-US", {
          timeZone: timezone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        });
        const lastRunParts = lastRunFormatter.formatToParts(lastRunDate);
        const lastRunYear = parseInt(lastRunParts.find((p) => p.type === "year")!.value);
        const lastRunMonth = parseInt(lastRunParts.find((p) => p.type === "month")!.value) - 1;
        const lastRunDay = parseInt(lastRunParts.find((p) => p.type === "day")!.value);
        const lastRunHour = parseInt(lastRunParts.find((p) => p.type === "hour")!.value);
        const lastRunMinute = parseInt(lastRunParts.find((p) => p.type === "minute")!.value);

        // Если последний запуск был сегодня и для этого же времени - пропускаем
        if (
          lastRunYear === currentTimeComponents.year &&
          lastRunMonth === currentTimeComponents.month &&
          lastRunDay === currentTimeComponents.day &&
          lastRunHour === scheduledHour &&
          lastRunMinute === scheduledMinute
        ) {
          continue;
        }
      }
      return true;
    }
  }

  return false;
}

/**
 * Получает список уже использованных идей для канала
 */
async function getUsedIdeasForChannel(channelId: string): Promise<string[]> {
  try {
    const { getAllJobs } = await import("../models/videoJob");
    const jobs = await getAllJobs();
    const channelJobs = jobs.filter((job) => job.channelId === channelId);
    return channelJobs
      .map((job) => job.ideaText)
      .filter((idea): idea is string => !!idea);
  } catch (error) {
    console.error(
      `[Automation] Error getting used ideas for channel ${channelId}:`,
      error
    );
    return [];
  }
}

/**
 * Создает автоматическую задачу генерации для канала
 */
async function createAutomatedJob(channel: Channel): Promise<string | null> {
  const timezone = channel.automation?.timeZone || DEFAULT_TIMEZONE;
  const runId = `auto-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  
  try {
    const timeString = formatDateInTimezone(Date.now(), timezone);
    
    console.log(
      `[Automation] Creating automated job for channel ${channel.id} (${channel.name})`
    );
    console.log(
      `[Automation] Timezone: ${timezone}, Current time: ${timeString}`
    );
    console.log(
      `[Automation] Schedule: ${channel.automation?.times.join(", ")}, Days: ${channel.automation?.daysOfWeek.join(", ")}`
    );

    // Устанавливаем флаг isRunning
    const { updateChannel } = await import("../models/channel");
    await updateChannel(channel.id, {
      automation: {
        ...channel.automation!,
        isRunning: true,
        runId,
      },
    });

    // Проверяем лимит активных задач
    const activeCount = await countActiveJobs(channel.id);
    const maxActive = channel.automation?.maxActiveTasks || 2;
    if (activeCount >= maxActive) {
      console.log(
        `[Automation] Channel ${channel.id} has ${activeCount} active jobs, max is ${maxActive}, skipping`
      );
      // Сбрасываем флаг isRunning
      await updateChannel(channel.id, {
        automation: {
          ...channel.automation!,
          isRunning: false,
          runId: null,
        },
      });
      return null;
    }

    // Шаг 1: Генерация идеи
    let ideas;
    try {
      const usedIdeas =
        channel.automation?.useOnlyFreshIdeas === true
          ? await getUsedIdeasForChannel(channel.id)
          : [];
      ideas = await generateIdeas(channel, null, 5);

      // Фильтруем использованные идеи, если нужно
      if (channel.automation?.useOnlyFreshIdeas === true && usedIdeas.length > 0) {
        ideas = ideas.filter(
          (idea) =>
            !usedIdeas.some(
              (used) =>
                used.toLowerCase().includes(idea.title.toLowerCase()) ||
                used.toLowerCase().includes(idea.description.toLowerCase())
            )
        );
      }

      if (ideas.length === 0) {
        console.warn(
          `[Automation] No fresh ideas for channel ${channel.id}, using any available`
        );
        ideas = await generateIdeas(channel, null, 5);
      }

      if (ideas.length === 0) {
        throw new Error("Failed to generate ideas");
      }
    } catch (error: any) {
      console.error(
        `[Automation] Error generating ideas for channel ${channel.id}:`,
        error
      );
      throw error;
    }

    // Выбираем первую идею
    const selectedIdea = ideas[0];
    console.log(
      `[Automation] Selected idea for channel ${channel.id}: ${selectedIdea.title}`
    );

    // Шаг 2: Генерация промпта
    let veoPromptResult;
    try {
      veoPromptResult = await generateVeoPrompt(channel, {
        title: selectedIdea.title,
        description: selectedIdea.description,
      });
    } catch (error: any) {
      console.error(
        `[Automation] Error generating prompt for channel ${channel.id}:`,
        error
      );
      throw error;
    }

    // Шаг 3: Создание задачи
    const job = await createJob(
      veoPromptResult.veoPrompt,
      channel.id,
      channel.name,
      `${selectedIdea.title}: ${selectedIdea.description}`,
      veoPromptResult.videoTitle
    );

    // Помечаем задачу как автоматическую
    const { updateJob } = await import("../models/videoJob");
    await updateJob(job.id, { isAuto: true });

    console.log(
      `[Automation] ✅ Created automated job ${job.id} for channel ${channel.id}`
    );

    // Обновляем lastRunAt и пересчитываем nextRunAt
    const { calculateNextRunAt } = await import("../utils/automationSchedule");
    
    if (channel.automation) {
      const nextRunAt = calculateNextRunAt(
        channel.automation.times,
        channel.automation.daysOfWeek,
        timezone,
        Date.now()
      );
      
      await updateChannel(channel.id, {
        automation: {
          ...channel.automation,
          lastRunAt: Date.now(),
          nextRunAt,
          isRunning: true,
          runId,
        },
      });
      
      if (nextRunAt) {
        const nextRunString = formatDateInTimezone(nextRunAt, timezone);
        console.log(
          `[Automation] Next run scheduled for: ${nextRunString} (${timezone})`
        );
      }
    }

    // Отправляем уведомление в Telegram (если настроено)
    try {
      const telegramChatId = process.env.AUTOMATION_DEBUG_CHAT_ID;
      if (telegramChatId) {
        const { getTelegramClient } = await import("../telegram/client");
        const client = await getTelegramClient();
        if (client) {
          await client.sendMessage(telegramChatId, {
            message: `[AUTOMATION] Канал "${channel.name}" (${channel.id}), запущен автогонератор в ${timeString} (${timezone}). Статус: успех. Job ID: ${job.id}`,
          });
        }
      }
    } catch (telegramError) {
      console.warn("[Automation] Failed to send Telegram notification:", telegramError);
    }

    return job.id;
  } catch (error: any) {
    console.error(
      `[Automation] Error creating automated job for channel ${channel.id}:`,
      error
    );
    
    // Сбрасываем флаг isRunning при ошибке
    try {
      const { updateChannel } = await import("../models/channel");
      await updateChannel(channel.id, {
        automation: {
          ...channel.automation!,
          isRunning: false,
          runId: null,
        },
      });
    } catch (updateError) {
      console.error("[Automation] Failed to reset isRunning flag:", updateError);
    }
    
    // Отправляем уведомление об ошибке
    try {
      const telegramChatId = process.env.AUTOMATION_DEBUG_CHAT_ID;
      if (telegramChatId) {
        const { getTelegramClient } = await import("../telegram/client");
        const client = await getTelegramClient();
        if (client) {
          const timeString = formatDateInTimezone(Date.now(), timezone);
          await client.sendMessage(telegramChatId, {
            message: `[AUTOMATION] Канал "${channel.name}" (${channel.id}), ошибка при запуске автогонератора в ${timeString} (${timezone}). Ошибка: ${error.message}`,
          });
        }
      }
    } catch (telegramError) {
      // Игнорируем ошибки Telegram
    }
    
    return null;
  }
}

/**
 * POST /api/automation/run-scheduled
 * Запускает автоматизацию для всех каналов, у которых наступило время
 */
router.post("/run-scheduled", async (req: Request, res: Response) => {
  try {
    const currentTimeUTC = new Date();
    const timeString = formatDateInTimezone(Date.now(), DEFAULT_TIMEZONE);
    
    console.log("[Automation] Running scheduled automation check...");
    console.log(`[Automation] UTC time: ${currentTimeUTC.toISOString()}`);
    console.log(`[Automation] ${DEFAULT_TIMEZONE} time: ${timeString}`);
    
    const intervalMinutes = 10; // Интервал проверки (10 минут)

    // Получаем все каналы
    const channels = await getAllChannels();
    const enabledChannels = channels.filter(
      (ch) => ch.automation?.enabled === true
    );

    console.log(
      `[Automation] Found ${enabledChannels.length} channels with automation enabled`
    );

    const results: Array<{
      channelId: string;
      channelName: string;
      jobId: string | null;
      error?: string;
      timezone?: string;
    }> = [];

    for (const channel of enabledChannels) {
      try {
        const timezone = channel.automation?.timeZone || DEFAULT_TIMEZONE;
        
        if (shouldRunAutomation(channel, intervalMinutes)) {
          console.log(
            `[Automation] Channel ${channel.id} (${channel.name}) should run automation (timezone: ${timezone})`
          );
          const jobId = await createAutomatedJob(channel);
          results.push({
            channelId: channel.id,
            channelName: channel.name,
            jobId,
            timezone,
          });
        }
      } catch (error: any) {
        console.error(
          `[Automation] Error processing channel ${channel.id}:`,
          error
        );
        results.push({
          channelId: channel.id,
          channelName: channel.name,
          jobId: null,
          error: error.message,
          timezone: channel.automation?.timeZone || DEFAULT_TIMEZONE,
        });
      }
    }

    console.log(
      `[Automation] Processed ${results.length} channels, ${results.filter((r) => r.jobId).length} jobs created`
    );

    res.json({
      success: true,
      timestamp: currentTimeUTC.toISOString(),
      timezone: DEFAULT_TIMEZONE,
      timezoneTime: timeString,
      processed: results.length,
      results,
    });
  } catch (error: any) {
    console.error("[Automation] Error in run-scheduled:", error);
    res.status(500).json({
      error: "Ошибка при запуске автоматизации",
      message: error.message,
    });
  }
});

export default router;

