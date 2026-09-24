-- AlterTable
ALTER TABLE "metric_snapshots" ALTER COLUMN "views" DROP NOT NULL,
ALTER COLUMN "likes" DROP NOT NULL,
ALTER COLUMN "comments" DROP NOT NULL;
