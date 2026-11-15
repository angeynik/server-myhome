#!/usr/bin/env python3
# tools/ptyPair.py
# Виртуальный нуль-модемный кабель для проверки Modbus RTU без железа (аналог socat):
# создаёт две псевдо-терминальные пары и пересылает байты между их ведущими сторонами.
#
# Запуск: python3 tools/ptyPair.py <каталог>
#   печатает в stdout два пути к портам через пробел и создаёт симлинки <каталог>/A и <каталог>/B.
#   Один конец открывает Slave, другой — Master. Работает до завершения процесса.
import os
import select
import sys
import tty


def main():
    if len(sys.argv) != 2:
        print('Использование: python3 tools/ptyPair.py <каталог>', file=sys.stderr)
        sys.exit(2)
    directory = sys.argv[1]
    masters = []
    for name in ('A', 'B'):
        master_fd, slave_fd = os.openpty()
        tty.setraw(slave_fd)
        link = os.path.join(directory, name)
        if os.path.lexists(link):
            os.unlink(link)
        os.symlink(os.ttyname(slave_fd), link)
        # slave_fd держим открытым: без него чтение ведущей стороны даёт EIO
        masters.append((master_fd, slave_fd))
    print(os.readlink(os.path.join(directory, 'A')), os.readlink(os.path.join(directory, 'B')), flush=True)

    (fd_a, _), (fd_b, _) = masters
    peer = {fd_a: fd_b, fd_b: fd_a}
    while True:
        ready, _, _ = select.select([fd_a, fd_b], [], [])
        for fd in ready:
            try:
                data = os.read(fd, 4096)
            except OSError:
                continue
            if data:
                os.write(peer[fd], data)


if __name__ == '__main__':
    main()
