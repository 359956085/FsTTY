type SettingsPageModule = typeof import("./SettingsPage");

interface LazySettingsPageModule {
  default: SettingsPageModule["SettingsPage"];
}

type SettingsPageImporter = () => Promise<SettingsPageModule>;

export function createSettingsPageLoader(importSettingsPage: SettingsPageImporter) {
  let loadingPromise: Promise<LazySettingsPageModule> | null = null;

  function load() {
    if (!loadingPromise) {
      loadingPromise = importSettingsPage()
        .then((module) => ({ default: module.SettingsPage }))
        .catch((error: unknown) => {
          // 预加载失败不能永久毒化 React.lazy；用户进入设置页时应能重试。
          loadingPromise = null;
          throw error;
        });
    }
    return loadingPromise;
  }

  function preload() {
    void load().catch(() => {
      // 后台预加载失败保持静默，真正打开设置页时再走正常错误链路。
    });
  }

  return { load, preload };
}

export const settingsPageLoader = createSettingsPageLoader(() => import("./SettingsPage"));
