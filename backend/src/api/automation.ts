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
  intervalMinutes: number = 6
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
 * Экспортируем для использования в планировщике
 */
export async function createAutomatedJob(channel: Channel): Promise<string | null> {
  const timezone = channel.automation?.timeZone || DEFAULT_TIMEZONE;
  const runId = `auto-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const startTime = Date.now();
  
  try {
    const timeString = formatDateInTimezone(Date.now(), timezone);
    
    console.log("─".repeat(80));
    console.log(`[Automation] 🚀 Creating automated job for channel: ${channel.id} (${channel.name})`);
    console.log(`[Automation] Run ID: ${runId}`);
    console.log(`[Automation] Timezone: ${timezone}, Current time: ${timeString}`);
    console.log(`[Automation] Schedule: ${channel.automation?.times.join(", ") || "none"}`);
    console.log(`[Automation] Days: ${channel.automation?.daysOfWeek.join(", ") || "none"}`);
    console.log("─".repeat(80));

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
      console.log("─".repeat(80));
      console.log(`[Automation] ⚠️  SKIPPED: Channel ${channel.id} has ${activeCount} active jobs, max is ${maxActive}`);
      console.log("─".repeat(80));
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

    const duration = Date.now() - startTime;
    console.log("─".repeat(80));
    console.log(`[Automation] ✅ SUCCESS: Created automated job ${job.id} for channel ${channel.id}`);
    console.log(`[Automation] Duration: ${duration}ms`);
    console.log(`[Automation] Idea: ${selectedIdea.title}`);
    console.log(`[Automation] Video title: ${veoPromptResult.videoTitle}`);
    console.log("─".repeat(80));

    // Обновляем lastRunAt и пересчитываем nextRunAt только после успешного создания задачи
    const { calculateNextRunAt } = await import("../utils/automationSchedule");
    
    if (channel.automation) {
      const now = Date.now();
      const nextRunAt = calculateNextRunAt(
        channel.automation.times,
        channel.automation.daysOfWeek,
        timezone,
        now // Используем текущее время как lastRunAt для расчета следующего
      );
      
      await updateChannel(channel.id, {
        automation: {
          ...channel.automation,
          lastRunAt: now,
          nextRunAt,
          isRunning: true,
          runId,
        },
      });
      
      if (nextRunAt) {
        const nextRunString = formatDateInTimezone(nextRunAt, timezone);
        console.log(
          `[Automation] ✅ Last run: ${timeString}, Next run scheduled for: ${nextRunString} (${timezone})`
        );
      } else {
        console.log(
          `[Automation] ⚠️ Last run: ${timeString}, but next run could not be calculated`
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
    const duration = Date.now() - startTime;
    console.error("─".repeat(80));
    console.error(`[Automation] ❌ ERROR: Failed to create automated job for channel ${channel.id}`);
    console.error(`[Automation] Error: ${error.message}`);
    console.error(`[Automation] Stack: ${error.stack}`);
    console.error(`[Automation] Duration: ${duration}ms`);
    console.error("─".repeat(80));
    
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
 * POST /api/channels/:channelId/automation/run-now
 * Ручной запуск автоматизации для конкретного канала (независимо от расписания)
 */
router.post("/channels/:channelId/run-now", async (req: Request, res: Response) => {
  try {
    const { channelId } = req.params;
    
    console.log(`[Automation] Manual run requested for channel ${channelId}`);
    
    // Получаем канал
    const channel = await getChannelById(channelId);
    if (!channel) {
      return res.status(404).json({
        error: "Канал не найден",
      });
    }
    
    // Проверяем, включена ли автоматизация
    if (!channel.automation || !channel.automation.enabled) {
      return res.status(400).json({
        error: "Автоматизация не включена для этого канала",
      });
    }
    
    // Проверяем, не выполняется ли уже автоматизация
    if (channel.automation.isRunning) {
      return res.status(400).json({
        error: "Автоматизация уже выполняется для этого канала",
      });
    }
    
    // Запускаем автоматизацию (игнорируя проверку времени/дней недели)
    const jobId = await createAutomatedJob(channel);
    
    if (!jobId) {
      return res.status(500).json({
        error: "Не удалось создать задачу автоматизации",
        message: "Возможно, достигнут лимит активных задач",
      });
    }
    
    console.log(`[Automation] ✅ Manual run completed for channel ${channelId}, job ${jobId}`);
    
    res.json({
      success: true,
      message: "Автоматизация запущена",
      jobId,
      channelId: channel.id,
      channelName: channel.name,
    });
  } catch (error: any) {
    console.error(`[Automation] Error in manual run for channel ${req.params.channelId}:`, error);
    res.status(500).json({
      error: "Ошибка при запуске автоматизации",
      message: error.message,
    });
  }
});

/**
 * POST /api/automation/run-scheduled
 * Запускает автоматизацию для всех каналов, у которых наступило время
 * 
 * Этот endpoint должен вызываться Cloud Scheduler каждые 5 минут.
 * 
 * Настройка Cloud Scheduler:
 * gcloud scheduler jobs create http automation-run-scheduled
 *   --location=europe-central2
 *   --schedule="каждые 5 минут"
 *   --uri="https://YOUR_SERVICE_URL/api/automation/run-scheduled"
 *   --http-method=POST
 *   --time-zone="Asia/Almaty"
 * 
 * См. CLOUD_SCHEDULER_SETUP.md для подробной инструкции.
 */
router.post("/run-scheduled", async (req: Request, res: Response) => {
  const startTime = Date.now();
  
  try {
    const currentTimeUTC = new Date();
    const timeString = formatDateInTimezone(Date.now(), DEFAULT_TIMEZONE);
    
    console.log("=".repeat(80));
    console.log("[Automation] ===== SCHEDULED AUTOMATION CHECK STARTED =====");
    console.log(`[Automation] Triggered by: ${req.headers['user-agent'] || 'Unknown'}`);
    console.log(`[Automation] UTC time: ${currentTimeUTC.toISOString()}`);
    console.log(`[Automation] ${DEFAULT_TIMEZONE} time: ${timeString}`);
    console.log("=".repeat(80));
    
    const intervalMinutes = 6; // Интервал проверки (6 минут) - больше чем частота Scheduler (5 минут), чтобы гарантировать попадание

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

    const jobsCreated = results.filter((r) => r.jobId).length;
    const duration = Date.now() - startTime;
    
    console.log("=".repeat(80));
    console.log(`[Automation] ===== SCHEDULED AUTOMATION CHECK COMPLETED =====`);
    console.log(`[Automation] Processed: ${results.length} channels`);
    console.log(`[Automation] Jobs created: ${jobsCreated}`);
    console.log(`[Automation] Duration: ${duration}ms`);
    console.log("=".repeat(80));

    res.json({
      success: true,
      timestamp: currentTimeUTC.toISOString(),
      timezone: DEFAULT_TIMEZONE,
      timezoneTime: timeString,
      processed: results.length,
      jobsCreated,
      duration: `${duration}ms`,
      results,
    });
  } catch (error: any) {
    const duration = Date.now() - startTime;
    console.error("=".repeat(80));
    console.error("[Automation] ===== SCHEDULED AUTOMATION CHECK FAILED =====");
    console.error(`[Automation] Error: ${error.message}`);
    console.error(`[Automation] Stack: ${error.stack}`);
    console.error(`[Automation] Duration: ${duration}ms`);
    console.error("=".repeat(80));
    
    res.status(500).json({
      error: "Ошибка при запуске автоматизации",
      message: error.message,
      duration: `${duration}ms`,
    });
  }
});

export default router;

