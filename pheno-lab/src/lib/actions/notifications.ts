"use server";

import { requireSession } from "@/lib/auth";
import {
  listNotifications as listNotificationsService,
  unreadNotificationCount,
  type NotificationRow,
} from "@/modules/notifications/service";

export type { NotificationRow };

/** Opening the panel: returns the latest items and marks them read. */
export async function listNotifications(): Promise<NotificationRow[]> {
  return listNotificationsService(await requireSession());
}

export async function getUnreadCount(): Promise<number> {
  return unreadNotificationCount(await requireSession());
}
