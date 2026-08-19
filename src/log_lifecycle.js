import pinia from "./pinia_instance.js";
import { useLogStore } from "./stores/log.js";
import { useGraphStore } from "./stores/graph.js";
import { useAppStore } from "./stores/app.js";
import { useCraftConfigStore } from "./stores/craftConfig.js";
import { formatTime, formatLogDateTime, stringLoopTime } from "./tools.js";
import { FIRMWARE_TYPE_ROTORFLIGHT } from "./flightlog_fielddefs.js";
import { resolveGearRatios } from "./craft_config.js";
import { logTimestamp } from "./tuning_log.js";

/**
 * Compare the flight log's craft name against the loaded craft config (if any), and set the
 * status bar's match/mismatch indicator and tooltip accordingly. On a mismatch, optionally also
 * offer (via a confirm dialog) to load a different config file - this should only happen when a
 * *log* was just opened, not when the *config* changes underneath an already-open log.
 *
 * Also syncs the matched craft's gear ratios into the flight log, which enables/disables the
 * motorSpeed/tailSpeed computed fields derived from headspeed. If that addition/removal changes
 * the flight log's field list, re-adapt the current graph config (so a workspace-saved graph
 * referencing motorSpeed/tailSpeed regains the field) and force a redraw.
 */
function checkCraftConfigMatch(logCraftName, promptOnMismatch) {
  const appStore = useAppStore(pinia);
  const craftConfigStore = useCraftConfigStore(pinia);
  const logStore = useLogStore(pinia);
  const graphStore = useGraphStore(pinia);

  appStore.statusCraftNameStatus = null;
  appStore.statusCraftNameTooltip = "";

  const nameMatches =
    craftConfigStore.hasConfig &&
    !!logCraftName &&
    !!craftConfigStore.craftName &&
    logCraftName.trim().toLowerCase() === craftConfigStore.craftName.trim().toLowerCase();

  if (nameMatches) {
    appStore.statusCraftNameStatus = "match";
    appStore.statusCraftNameTooltip = `Loaded configuration ${craftConfigStore.craftName} matches this flight log's craft.`;
  } else if (craftConfigStore.hasConfig && logCraftName && craftConfigStore.craftName) {
    appStore.statusCraftNameStatus = "mismatch";
    appStore.statusCraftNameTooltip = `Loaded configuration is for "${craftConfigStore.craftName}", but this flight log is for "${logCraftName}".`;

    if (promptOnMismatch !== false) {
      appStore.craftNameMismatchMessage = appStore.statusCraftNameTooltip;
      appStore.craftNameMismatchDialogOpen = true;
    }
  }

  const gearRatios = nameMatches
    ? resolveGearRatios(craftConfigStore.mainRotorGearRatio, craftConfigStore.tailRotorGearRatio)
    : null;

  const result = logStore.flightLog?.setCraftGearRatios(gearRatios);

  if (result?.fieldsChanged && graphStore.graphConfig) {
    graphStore.activeGraphConfig?.adaptGraphs(logStore.flightLog, graphStore.graphConfig);
  }
  if (result?.valuesChanged) {
    graphStore.graph?.refreshGraphConfig();
    graphStore.invalidateGraph?.();
  }
}

/**
 * Re-run the craft name comparison for the currently displayed log, without prompting on a
 * mismatch. Call this when the loaded craft config changes (loaded/cleared) while a log is open.
 */
export function recheckCraftConfigMatch() {
  const logStore = useLogStore(pinia);

  if (!logStore.flightLog) {
    return;
  }

  checkCraftConfigMatch(logStore.flightLog.getSysConfig()["Craft name"], false);
}

export function renderLogFileInfo(file) {
  const logStore = useLogStore(pinia);
  const appStore = useAppStore(pinia);

  appStore.logFilename = file.name;
  appStore.logFileLastModified = file.lastModified ?? null;

  const logCount = logStore.flightLog.getLogCount();
  const entries = [];
  for (let index = 0; index < logCount; index++) {
    const error = logStore.flightLog.getLogError(index);
    let logLabel;
    if (error) {
      logLabel = error;
    } else {
      // Parse this sub-log's own header so its "Log start datetime" (which can differ per
      // arm/disarm session within a multi-log file) is available for the dropdown entry below.
      // getLogError() above only reflects the lightweight index-scan pass, so a full header parse
      // can still fail here - fall back to no date/time rather than aborting the whole file load.
      let dateTime = "";
      try {
        logStore.flightLog.openLog(index);
        dateTime = formatLogDateTime(
          logTimestamp(logStore.flightLog.getSysConfig(), appStore.logFileLastModified),
        );
      } catch {
        // Leave dateTime blank; the elapsed-time range below is still shown.
      }

      const durationLabel = `[${formatTime(
        Math.ceil(
          (logStore.flightLog.getMaxTime(index) - logStore.flightLog.getMinTime(index)) / 1000,
        ),
        false,
      )}]`;
      logLabel = dateTime ? `${dateTime}  ${durationLabel}` : durationLabel;
    }
    const label = logCount > 1
      ? `${index + 1}/${logCount}: ${logLabel}`
      : logLabel;
    entries.push({ label, value: index, disabled: !!error });
  }
  logStore.logIndexEntries = entries;
  logStore.activeLogIndex = 0;
}

export function renderSelectedLogInfo() {
  const logStore = useLogStore(pinia);
  const appStore = useAppStore(pinia);
  const graphStore = useGraphStore(pinia);

  logStore.activeLogIndex = logStore.flightLog.getLogIndex();

  if (logStore.flightLog.getNumCellsEstimate()) {
    appStore.statusCells = `${logStore.flightLog.getNumCellsEstimate()}S (${Number(
      logStore.flightLog.getReferenceVoltageMillivolts() / 1000,
    ).toFixed(2)}V)`;
  } else {
    appStore.statusCells = "";
  }

  const sysConfig = logStore.flightLog.getSysConfig();

  appStore.statusCraftName = sysConfig["Craft name"]?.length
    ? `${sysConfig["Craft name"]} : `
    : "";
  appStore.statusFirmwareInfo =
    (sysConfig["Firmware revision"] == null
      ? ""
      : `${sysConfig["Firmware revision"]}`) +
    (sysConfig.deviceUID == null ? "" : ` (${sysConfig.deviceUID})`);

  checkCraftConfigMatch(sysConfig["Craft name"]);

  const looptimeText = stringLoopTime(
    sysConfig.looptime,
    sysConfig.pid_process_denom,
    sysConfig.unsynced_fast_pwm,
    sysConfig.motor_pwm_rate,
  );
  appStore.statusLooptime = looptimeText;

  const lograteText =
    sysConfig["frameIntervalPDenom"] != null &&
    sysConfig["frameIntervalPNum"] != null
      ? `Sample Rate : ${sysConfig["frameIntervalPNum"]}/${sysConfig["frameIntervalPDenom"]}`
      : "";
  appStore.statusLograte = lograteText;

  // Rotorflight has no throttle stick to average across motors; show collective position instead,
  // and there's nothing else meaningful to pick from, so force that mode.
  const isRotorflight = sysConfig.firmwareType === FIRMWARE_TYPE_ROTORFLIGHT;
  if (isRotorflight) {
    graphStore.seekBarMode = "collective";
  }

  const seekBar = graphStore.seekBar;
  seekBar.setTimeRange(
    logStore.flightLog.getMinTime(),
    logStore.flightLog.getMaxTime(),
    logStore.currentBlackboxTime,
  );
  if (isRotorflight) {
    const [collectiveMin, collectiveMax] = sysConfig.collectiveRange ?? [-500, 500];
    seekBar.setActivityRange(collectiveMin, collectiveMax);
  } else {
    seekBar.setActivityRange(
      logStore.flightLog.getSysConfig().motorOutput[0],
      logStore.flightLog.getSysConfig().motorOutput[1],
    );
  }

  const activity = logStore.flightLog.getActivitySummary();
  seekBar.setActivity(
    activity.times,
    activity[graphStore.seekBarMode],
    activity.hasEvent,
  );
  seekBar.repaint();

  if (logStore.flightLog.hasGpsData()) {
    graphStore.mapGrapher.setFlightLog(logStore.flightLog);
  }
}

export function setSeekBarMode(mode) {
  const logStore = useLogStore(pinia);
  const graphStore = useGraphStore(pinia);

  graphStore.seekBarMode = mode;
  if (logStore.flightLog) {
    const activity = logStore.flightLog.getActivitySummary();
    graphStore.seekBar.setActivity(activity.times, activity[mode], activity.hasEvent);
    graphStore.seekBar.repaint();
  }
}
