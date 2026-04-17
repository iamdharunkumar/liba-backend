FROM heroiclabs/nakama:3.22.0

# Copy your built Tic-Tac-Toe module into the container
COPY ./modules/ /nakama/data/modules/

# Create a startup script that migrates the DB then starts the server
RUN echo '#!/bin/sh' > /start.sh && \
    echo '/nakama/nakama migrate up --database.address $DB_URL && exec /nakama/nakama --name nakama --database.address $DB_URL --session.token_expiry_sec 7200' >> /start.sh && \
    chmod +x /start.sh

# Run our script when Render boots up the container
ENTRYPOINT ["/start.sh"]
