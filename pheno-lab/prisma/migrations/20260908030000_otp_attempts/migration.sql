-- Failed-verify counter so password-reset codes lock after repeated guesses.
ALTER TABLE "OtpCode" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0;
