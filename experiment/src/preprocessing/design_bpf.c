/* Prewarped Butterworth prototype N=2 -> digital bandpass order 4.
 * C owns pole/SOS design and response verification. No audio input here. */
#include <errno.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <fcntl.h>
#include <io.h>
#include <sys/stat.h>
#define PI 3.14159265358979323846
typedef struct { double re, im; } C;
typedef struct { double b[3], a[3]; C pole; } SOS;
static void fail(const char *s) { fprintf(stderr, "BPF design failed: %s\n", s); exit(1); }
static C add(C a,C b) { C r={a.re+b.re,a.im+b.im}; return r; }
static C sub(C a,C b) { C r={a.re-b.re,a.im-b.im}; return r; }
static C mul(C a,C b) { C r={a.re*b.re-a.im*b.im,a.re*b.im+a.im*b.re}; return r; }
static C scale(C a,double k) { C r={a.re*k,a.im*k}; return r; }
static double mag(C a) { return hypot(a.re,a.im); }
static C divide(C a,C b) { double d=b.re*b.re+b.im*b.im; C r={(a.re*b.re+a.im*b.im)/d,(a.im*b.re-a.re*b.im)/d}; if (!(d>0)) fail("singular division"); return r; }
static C root(C a) { double m=mag(a); C r={sqrt(fmax(0,(m+a.re)/2)),copysign(sqrt(fmax(0,(m-a.re)/2)),a.im)}; return r; }
static C response(SOS *s,double f,double fs) {
    double w=2*PI*f/fs; C z={cos(w),-sin(w)},z2=mul(z,z),one={1,0};
    return divide(add(add(scale(one,s->b[0]),scale(z,s->b[1])),scale(z2,s->b[2])),add(add(one,scale(z,s->a[1])),scale(z2,s->a[2])));
}
static C cascade(SOS *s,double f,double fs) { return mul(response(s,f,fs),response(s+1,f,fs)); }
static double num(const char *s) { char *e; double v; errno=0; v=strtod(s,&e); if(errno||e==s||*e||!isfinite(v)) fail("finite parameters required"); return v; }
int main(int argc,char **argv) {
    double fs,lo,hi,l,u,bw,center,maxerror=0; C p,v,d,two={2,0},four; SOS s[2]; FILE *out; int i,j;
    if(argc!=5) fail("expected sample_rate lower upper NEW_response.csv");
    fs=num(argv[1]); lo=num(argv[2]); hi=num(argv[3]);
    if(fs!=16000||!(lo>0&&lo<hi&&hi<fs/2)) fail("expected ordered cutoffs inside 16kHz Nyquist");
    l=tan(PI*lo/fs); u=tan(PI*hi/fs); bw=u-l; center=fs/PI*atan(sqrt(l*u));
    p.re=-sqrt(.5); p.im=sqrt(.5); v=scale(p,2*bw); four.re=16*l*u; four.im=0; d=root(sub(mul(v,v),four));
    for(i=0;i<2;i++) {
        C analog=scale(i?sub(v,d):add(v,d),.5),pole=divide(add(two,analog),sub(two,analog));
        pole.im=fabs(pole.im); s[i].pole=pole;
    }
    if(s[0].pole.re>s[1].pole.re) { SOS swap=s[0]; s[0]=s[1]; s[1]=swap; }
    for(i=0;i<2;i++) {
        double g;
        if(!(mag(s[i].pole)<1)) fail("unstable pole");
        s[i].a[0]=1; s[i].a[1]=-2*s[i].pole.re; s[i].a[2]=pow(mag(s[i].pole),2);
        s[i].b[0]=1; s[i].b[1]=i?-2:2; s[i].b[2]=1;
        g=1/mag(response(s+i,center,fs)); for(j=0;j<3;j++) s[i].b[j]*=g;
    }
    { FILE *existing=fopen(argv[4],"rb"); if(existing) { fclose(existing); fail("response exists; preserve completed results"); } }
    { int fd=_open(argv[4],_O_WRONLY|_O_CREAT|_O_EXCL|_O_BINARY,_S_IREAD|_S_IWRITE); if(fd<0) fail("cannot exclusively create response"); out=_fdopen(fd,"w"); if(!out) { _close(fd); fail("cannot open response stream"); } }
    fprintf(out,"frequency_hz,real,imag,power_gain,gain_db\n");
    for(i=0;i<=16003;i++) {
        double f=i<=16000?i*.5:(i==16001?lo:(i==16002?hi:center)),actual,expected=0;
        C h=cascade(s,f,fs); actual=pow(mag(h),2);
        if(f>0&&f<fs/2) { double x=tan(PI*f/fs),m=(x*x-l*u)/(x*bw); expected=1/(1+pow(m,4)); }
        if(fabs(actual-expected)>maxerror) maxerror=fabs(actual-expected);
        fprintf(out,"%.17g,%.17g,%.17g,%.17g,%.17g\n",f,h.re,h.im,actual,10*log10(fmax(actual,1e-30)));
    }
    if(ferror(out)||fclose(out)) fail("response write failed");
    if(maxerror>1e-9||fabs(pow(mag(cascade(s,lo,fs)),2)-.5)>1e-9||fabs(pow(mag(cascade(s,hi,fs)),2)-.5)>1e-9) fail("response verification failed");
    printf("{\"tool_version\":\"cnr-butterworth-design/1\",\"verification\":\"passed\",\"sample_rate_hz\":16000,\"prototype_order\":2,\"digital_order\":4,\"lower_hz\":%.17g,\"upper_hz\":%.17g,\"peak_frequency_hz\":%.17g,\"bandwidth_hz\":%.17g,\"passband_peak_gain_db\":0,\"maximum_power_response_error\":%.17g,\"response_rows\":16004,\"sections\":[",lo,hi,center,hi-lo,maxerror);
    for(i=0;i<2;i++) printf("%s{\"b\":[%.17g,%.17g,%.17g],\"a\":[1,%.17g,%.17g],\"pole_radius\":%.17g}",i?",":"",s[i].b[0],s[i].b[1],s[i].b[2],s[i].a[1],s[i].a[2],mag(s[i].pole));
    printf("]}\n"); return 0;
}
