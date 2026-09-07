"use server";

import { requireSession } from "@/lib/auth";
import {
  addComment as addCommentService,
  deleteComment as deleteCommentService,
  listComments as listCommentsService,
  type CommentRow,
} from "@/modules/experiments/comment-service";

export async function listExperimentComments(
  experimentId: string,
): Promise<CommentRow[]> {
  return listCommentsService(await requireSession(), experimentId);
}

export async function addExperimentComment(data: {
  experimentId: string;
  body: string;
  mentionIds: string[];
}): Promise<CommentRow> {
  return addCommentService(await requireSession(), data);
}

export async function deleteExperimentComment(
  commentId: string,
): Promise<void> {
  await deleteCommentService(await requireSession(), commentId);
}
