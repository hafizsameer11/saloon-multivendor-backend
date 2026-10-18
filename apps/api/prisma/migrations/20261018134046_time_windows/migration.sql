-- AlterTable
ALTER TABLE `Booking` ADD COLUMN `windowId` VARCHAR(191) NULL;

-- CreateTable
CREATE TABLE `TimeWindow` (
    `id` VARCHAR(191) NOT NULL,
    `salonId` VARCHAR(191) NOT NULL,
    `date` VARCHAR(10) NOT NULL,
    `startMin` INTEGER NOT NULL,
    `endMin` INTEGER NOT NULL,
    `serviceIds` JSON NOT NULL,
    `capacity` INTEGER NOT NULL,
    `staffId` VARCHAR(191) NULL,
    `note` VARCHAR(120) NOT NULL DEFAULT '',
    `open` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `TimeWindow_salonId_date_idx`(`salonId`, `date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `Booking_windowId_idx` ON `Booking`(`windowId`);

-- AddForeignKey
ALTER TABLE `Booking` ADD CONSTRAINT `Booking_windowId_fkey` FOREIGN KEY (`windowId`) REFERENCES `TimeWindow`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TimeWindow` ADD CONSTRAINT `TimeWindow_salonId_fkey` FOREIGN KEY (`salonId`) REFERENCES `Salon`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
