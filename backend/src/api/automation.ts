import { Router, Request, Response } from "express";
import { getAllChannels, getChannelById, Channel } from "../models/channel";
import { createJob, countActiveJobs } from "../models/videoJob";
import { generateIdeas } from "../services/openaiService";
import { generateVeoPrompt } from "../services/openaiService";

const router = Router();

/**
 * Преобразует день недели в формат для проверки
 * Возвращает массив строк ["Mon", "Tue", ...] или ["1", "2", ...]
 */
function getCurrentDayOfWeek(): string {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return days[new Date().getDay()];
}

function getCurrentDayOfWeekNumber(): string {
  return String(new Date().getDay() + 1); // 1-7, где 1 = воскресенье
}

/**
 * Проверяет, нужно ли запускать автоматизацию для канала в текущее время
 */
function shouldRunAutomation(
  channel: Channel,
  currentTime: Date,
  intervalMinutes: number = 5
): boolean {
  if (!channel.automation || !channel.automation.enabled) {
    return false;
  }

  const automation = channel.automation;

  // Проверяем день недели
  const currentDay = getCurrentDayOfWeek();
  const currentDayNumber = getCurrentDayOfWeekNumber();
  const isDayMatch =
    automation.daysOfWeek.includes(currentDay) ||
    automation.daysOfWeek.includes(currentDayNumber);
  if (!isDayMatch) {
    return false;
  }

  // Проверяем время
  const currentHour = currentTime.getHours();
  const currentMinute = currentTime.getMinutes();
  const currentTimeString = `${String(currentHour).padStart(2, "0")}:${String(
    currentMinute
  ).padStart(2, "0")}`;

  // Проверяем, есть ли запланированное время в интервале
  for (const scheduledTime of automation.times) {
    const [scheduledHour, scheduledMinute] = scheduledTime.split(":").map(Number);
    const scheduledDate = new Date(currentTime);
    scheduledDate.setHours(scheduledHour, scheduledMinute, 0, 0);

    // Проверяем, что время уже наступило и в пределах интервала
    const diffMinutes =
      (currentTime.getTime() - scheduledDate.getTime()) / (1000 * 60);
    if (diffMinutes >= 0 && diffMinutes <= intervalMinutes) {
      // Проверяем, не было ли уже запуска сегодня для этого времени
      if (automation.lastRunAt) {
        const lastRunDate = new Date(automation.lastRunAt);
        // Если последний запуск был сегодня и для этого же времени - пропускаем
        if (
          lastRunDate.toDateString() === currentTime.toDateString() &&
          lastRunDate.getHours() === scheduledHour &&
          lastRunDate.getMinutes() === scheduledMinute
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
  try {
    console.log(`[Automation] Creating automated job for channel ${channel.id}`);

    // Проверяем лимит активных задач
    const activeCount = await countActiveJobs(channel.id);
    const maxActive = channel.automation?.maxActiveTasks || 2;
    if (activeCount >= maxActive) {
      console.log(
        `[Automation] Channel ${channel.id} has ${activeCount} active jobs, max is ${maxActive}, skipping`
      );
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

    // Обновляем lastRunAt для канала
    const { updateChannel } = await import("../models/channel");
    if (channel.automation) {
      await updateChannel(channel.id, {
        automation: {
          ...channel.automation,
          lastRunAt: Date.now(),
        },
      });
    }

    return job.id;
  } catch (error: any) {
    console.error(
      `[Automation] Error creating automated job for channel ${channel.id}:`,
      error
    );
    return null;
  }
}

/**
 * POST /api/automation/run-scheduled
 * Запускает автоматизацию для всех каналов, у которых наступило время
 */
router.post("/run-scheduled", async (req: Request, res: Response) => {
  try {
    console.log("[Automation] Running scheduled automation check...");
    const currentTime = new Date();
    const intervalMinutes = 10; // Интервал проверки (5-10 минут)

    // Получаем все каналы
    const channels = await getAllChannels();
    const enabledChannels = channels.filter(
      (ch) => ch.automation?.enabled === true
    );

    console.log(
      `[Automation] Found ${enabledChannels.length} channels with automation enabled`
    );

    const results: Array<{ channelId: string; jobId: string | null; error?: string }> = [];

    for (const channel of enabledChannels) {
      try {
        if (shouldRunAutomation(channel, currentTime, intervalMinutes)) {
          console.log(
            `[Automation] Channel ${channel.id} (${channel.name}) should run automation`
          );
          const jobId = await createAutomatedJob(channel);
          results.push({ channelId: channel.id, jobId });
        }
      } catch (error: any) {
        console.error(
          `[Automation] Error processing channel ${channel.id}:`,
          error
        );
        results.push({
          channelId: channel.id,
          jobId: null,
          error: error.message,
        });
      }
    }

    res.json({
      success: true,
      timestamp: currentTime.toISOString(),
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

