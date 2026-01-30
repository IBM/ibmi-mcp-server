ARG PG_MAJOR=17
ARG DEBIAN_CODENAME=bookworm
FROM postgres:$PG_MAJOR-$DEBIAN_CODENAME
ARG PGVECTOR_VERSION=v0.8.1

RUN apt-get update && \
		apt-mark hold locales && \
		apt-get install -y --no-install-recommends build-essential postgresql-server-dev-$PG_MAJOR ca-certificates git && \
		git clone --branch $PGVECTOR_VERSION --depth 1 https://github.com/pgvector/pgvector.git /tmp/pgvector && \
		cd /tmp/pgvector && \
		make clean && \
		make OPTFLAGS="" && \
		make install && \
		mkdir /usr/share/doc/pgvector && \
		cp LICENSE README.md /usr/share/doc/pgvector && \
		rm -r /tmp/pgvector && \
		apt-get remove -y build-essential postgresql-server-dev-$PG_MAJOR && \
		apt-get autoremove -y && \
		apt-mark unhold locales && \
		rm -rf /var/lib/apt/lists/*

RUN mkdir -p /docker-entrypoint-initdb.d
COPY scripts/initdb-extensions.sh /docker-entrypoint-initdb.d/initdb-extensions.sh