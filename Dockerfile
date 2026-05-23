FROM nginx:alpine
COPY sahagroup-fair30-wheel.html /usr/share/nginx/html/index.html
COPY Logowacoal-01-scaled.jpg /usr/share/nginx/html/Logowacoal-01-scaled.jpg
COPY Logo-Guy-Laroche-Innerwear.jpg /usr/share/nginx/html/Logo-Guy-Laroche-Innerwear.jpg
COPY BSC-Cosmetology.jpeg /usr/share/nginx/html/BSC-Cosmetology.jpeg
COPY Logo-Enfant-Blue.jpg /usr/share/nginx/html/Logo-Enfant-Blue.jpg
COPY nginx.conf.template /nginx.conf.template
COPY start.sh /start.sh
RUN chmod +x /start.sh && rm /etc/nginx/conf.d/default.conf
CMD ["/start.sh"]
