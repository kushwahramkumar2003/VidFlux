-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'PROCESSED', 'FAILED');

-- AlterTable
ALTER TABLE "RawVideo" ADD COLUMN     "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING';
